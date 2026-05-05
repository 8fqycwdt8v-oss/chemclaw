"""Tests for the RedactionFilter — log records must be scrubbed for chemistry
PII (SMILES, internal compound codes, project IDs, emails) before reaching
the formatter."""

from __future__ import annotations

import logging
from io import StringIO

import pytest

from services.mcp_tools.common.redaction_filter import RedactionFilter


def _make_logger(name: str, fmt: str) -> tuple[logging.Logger, StringIO]:
    logger = logging.getLogger(name)
    logger.handlers.clear()
    buf = StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(logging.Formatter(fmt))
    handler.addFilter(RedactionFilter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger, buf


def test_email_in_message_is_redacted() -> None:
    logger, buf = _make_logger("redact.email", "%(message)s")
    logger.info("Operator alice@example.com triggered the run")
    out = buf.getvalue()
    assert "alice@example.com" not in out
    # The redactor replaces the email with a tag like <EMAIL_xxxxxxxx>.
    assert "<EMAIL_" in out


def test_compound_code_is_redacted() -> None:
    logger, buf = _make_logger("redact.compound", "%(message)s")
    logger.info("Computing properties for CMP-123456")
    out = buf.getvalue()
    assert "CMP-123456" not in out
    # The redactor labels compound codes with the `CMP` kind tag.
    assert "<CMP_" in out


def test_nce_project_id_is_redacted() -> None:
    logger, buf = _make_logger("redact.nce", "%(message)s")
    logger.info("Project NCE-042 enrolled")
    out = buf.getvalue()
    assert "NCE-042" not in out
    # The redactor labels NCE project ids with the `NCE` kind tag.
    assert "<NCE_" in out


def test_smiles_string_is_redacted() -> None:
    logger, buf = _make_logger("redact.smiles", "%(message)s")
    logger.info("Got input CC(=O)Oc1ccccc1C(=O)O")
    out = buf.getvalue()
    assert "CC(=O)Oc1ccccc1C(=O)O" not in out
    assert "<SMILES_" in out


def test_extras_dict_strings_are_redacted() -> None:
    logger, buf = _make_logger(
        "redact.extras", "%(message)s|%(payload)s"
    )
    logger.info("event", extra={"payload": {"smiles": "CC(=O)Oc1ccccc1C(=O)O"}})
    out = buf.getvalue()
    assert "CC(=O)Oc1ccccc1C(=O)O" not in out


def test_passthrough_fields_are_preserved() -> None:
    """`request_id`, `service`, etc. must NOT be redacted — they're
    correlation handles that look benign but contain UUIDs that the
    redactor would otherwise mangle (it has no SMILES rule for UUIDs but
    the protective list still matters in case future patterns add one)."""
    logger, buf = _make_logger(
        "redact.passthrough", "%(message)s|%(request_id)s"
    )
    rid = "11111111-2222-3333-4444-555555555555"
    logger.info("hello", extra={"request_id": rid})
    line = buf.getvalue().strip()
    assert line.endswith(rid)


def test_redactor_failure_does_not_crash_logging(monkeypatch: pytest.MonkeyPatch) -> None:
    """Defense-in-depth: if `redact()` raises, the record passes through
    unmodified rather than crashing the service."""
    import services.mcp_tools.common.redaction_filter as rf

    def boom(_: str) -> None:
        raise RuntimeError("redactor exploded")

    monkeypatch.setattr(rf, "_redact_fn", boom)

    logger, buf = _make_logger("redact.crash", "%(message)s")
    logger.info("plain text")
    assert "plain text" in buf.getvalue()


def test_exc_text_traceback_is_redacted() -> None:
    """DR-14: traceback strings (`exc_text`, `stack_info`) regularly carry
    SMILES / compound codes embedded in psycopg "Failing row contains (...)"
    error messages — they must be redacted on the same surface as `msg`."""
    logger, buf = _make_logger("redact.exc", "%(message)s|%(exc_text)s")
    try:
        raise RuntimeError("Failing row contains CC(=O)Oc1ccccc1C(=O)O")
    except RuntimeError:
        logger.exception("upstream failure")
    out = buf.getvalue()
    # The exception message embeds the SMILES verbatim — the filter must
    # redact `exc_text` (which the formatter renders into the line above).
    assert "CC(=O)Oc1ccccc1C(=O)O" not in out
    assert "<SMILES_" in out


def test_stack_info_without_exc_info_is_redacted() -> None:
    """DR-14: `stack_info=True` populates `record.stack_info` independently
    of `exc_info`. The filter has a separate branch for that — make sure
    a SMILES / compound code in a frame's source line gets redacted too.

    We can't easily make Python dump source containing real SMILES, so we
    seed `record.stack_info` directly via the logging.makeRecord path."""
    logger, buf = _make_logger("redact.stack", "%(message)s|%(stack_info)s")
    record = logger.makeRecord(
        name=logger.name,
        level=logging.WARNING,
        fn=__file__,
        lno=1,
        msg="trace",
        args=None,
        exc_info=None,
    )
    record.stack_info = (
        "Stack (most recent call last):\n"
        '  File "x.py", line 1, in foo\n'
        "    raise RuntimeError('seen CMP-987654 in flight')"
    )
    logger.handle(record)
    out = buf.getvalue()
    assert "CMP-987654" not in out
    assert "<CMP_" in out


def test_chained_exception_context_is_redacted() -> None:
    """`raise ... from prior` traverses __cause__ when the formatter renders
    the traceback. The filter must redact the joined string, not just the
    outer frame — the inner exception message often carries the unsafe
    SMILES (e.g. driver wrapping a row error)."""
    logger, buf = _make_logger("redact.chained", "%(message)s|%(exc_text)s")
    try:
        try:
            raise ValueError("inner: NCE-042 leak")
        except ValueError as inner:
            raise RuntimeError("outer wrapper") from inner
    except RuntimeError:
        logger.exception("chained boom")
    out = buf.getvalue()
    # Inner message must be redacted even though only the outer was raised
    # by the function that called logger.exception.
    assert "NCE-042" not in out
    assert "<NCE_" in out


def test_long_traceback_with_multiple_secrets_redacts_all_occurrences() -> None:
    """Defensive: a stack with several SMILES / compound codes must have
    every occurrence replaced — a partial redaction is a leak. We
    construct an artificially-deep traceback so the filter has to cope
    with a multi-frame string."""
    logger, buf = _make_logger("redact.deep", "%(message)s|%(exc_text)s")

    def _level3() -> None:
        raise RuntimeError("crash on CC(=O)Oc1ccccc1C(=O)O and CMP-111111")

    def _level2() -> None:
        try:
            _level3()
        except RuntimeError as e:
            # `from None` strips the cause and forces a single chain
            raise RuntimeError("mid-frame for NCE-077") from e

    def _level1() -> None:
        _level2()

    try:
        _level1()
    except RuntimeError:
        logger.exception("deep stack")

    out = buf.getvalue()
    # Each unique secret must be gone.
    assert "CC(=O)Oc1ccccc1C(=O)O" not in out
    assert "CMP-111111" not in out
    assert "NCE-077" not in out
    # And the redaction tags are present, proving the filter actually ran.
    assert "<SMILES_" in out
    assert "<CMP_" in out
    assert "<NCE_" in out
