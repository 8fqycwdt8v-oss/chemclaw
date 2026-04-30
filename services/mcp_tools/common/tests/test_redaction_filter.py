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
