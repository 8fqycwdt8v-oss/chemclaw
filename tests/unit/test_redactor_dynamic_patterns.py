"""Tests for services/litellm_redactor/dynamic_patterns.py.

Phase 3 of the configuration concept (Initiative 4).
"""

from __future__ import annotations

import re
from unittest.mock import MagicMock, patch

import pytest

from services.litellm_redactor.dynamic_patterns import (
    DynamicPattern,
    DynamicPatternLoader,
    is_pattern_safe,
)


# ---------------------------------------------------------------------------
# is_pattern_safe — second line of defence after the DB CHECK constraint
# ---------------------------------------------------------------------------


def test_safe_bounded_pattern_passes() -> None:
    ok, why = is_pattern_safe(r"\bABC-\d{4,8}\b")
    assert ok, why


def test_unbounded_dot_star_rejected() -> None:
    ok, why = is_pattern_safe(r"foo.*bar")
    assert not ok
    assert "unbounded" in (why or "").lower()


def test_unbounded_dot_plus_rejected() -> None:
    ok, why = is_pattern_safe(r"foo.+bar")
    assert not ok


def test_unbounded_S_plus_rejected() -> None:
    ok, why = is_pattern_safe(r"foo\S+bar")
    assert not ok


def test_unbounded_w_plus_rejected() -> None:
    ok, why = is_pattern_safe(r"foo\w+bar")
    assert not ok


def test_bounded_dot_with_upper_bound_accepted() -> None:
    # `.{0,200}` is the canonical bounded form — accepted.
    ok, why = is_pattern_safe(r"foo.{0,200}bar")
    assert ok, why


def test_oversize_pattern_rejected() -> None:
    big = "a" * 300
    ok, why = is_pattern_safe(big)
    assert not ok
    assert "length" in (why or "").lower()


def test_invalid_regex_rejected() -> None:
    ok, why = is_pattern_safe(r"[unclosed")
    assert not ok
    assert "compile" in (why or "").lower()


# ---------------------------------------------------------------------------
# DynamicPatternLoader — caching + DB outage
# ---------------------------------------------------------------------------


def _patched_loader(rows: list[tuple]) -> tuple[object, MagicMock]:
    """Returns (context_manager, fake_conn). fake_conn.execute_count tracks calls."""
    fake_cur = MagicMock()
    fake_cur.fetchall.return_value = rows
    fake_cur.execute = MagicMock()
    fake_conn = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cur
    fake_conn.cursor.return_value.__exit__.return_value = False
    fake_conn.__enter__.return_value = fake_conn
    fake_conn.__exit__.return_value = False
    cm = patch(
        "services.litellm_redactor.dynamic_patterns.psycopg.connect",
        return_value=fake_conn,
    )
    return cm, fake_cur


def test_loader_returns_compiled_patterns() -> None:
    rows = [
        ("CMP", r"\bCMP-\d{4,8}\b", True, "global", ""),
        ("EMAIL", r"[a-z]{1,64}@[a-z]{1,64}\.[a-z]{2,6}", False, "global", ""),
    ]
    cm, _ = _patched_loader(rows)
    with cm:
        loader = DynamicPatternLoader(dsn="dsn-stub")
        patterns = loader.get_patterns()
    assert len(patterns) == 2
    cmp = next(p for p in patterns if p.category == "CMP")
    assert cmp.pattern.search("see CMP-12345") is not None
    # IGNORECASE flag honoured.
    assert cmp.pattern.search("see cmp-12345") is not None


def test_loader_skips_unsafe_patterns() -> None:
    rows = [
        ("CMP", r"\bCMP-\d{4,8}\b", True, "global", ""),
        # Unbounded — should be silently dropped.
        ("CUSTOM", r"foo.*bar", False, "global", ""),
    ]
    cm, _ = _patched_loader(rows)
    with cm:
        loader = DynamicPatternLoader(dsn="dsn-stub")
        patterns = loader.get_patterns()
    assert len(patterns) == 1
    assert patterns[0].category == "CMP"


def test_loader_skips_uncompilable_patterns() -> None:
    rows = [
        ("CMP", r"\bCMP-\d{4,8}\b", True, "global", ""),
        # is_pattern_safe catches `[unclosed` first via re.compile in the safety
        # check, so this row is dropped at the safety gate, not the load gate.
        # Either way the loader returns only one pattern.
        ("CUSTOM", r"[unclosed", False, "global", ""),
    ]
    cm, _ = _patched_loader(rows)
    with cm:
        loader = DynamicPatternLoader(dsn="dsn-stub")
        patterns = loader.get_patterns()
    assert len(patterns) == 1


def test_loader_caches_within_ttl() -> None:
    rows = [("CMP", r"\bCMP-\d{4}\b", True, "global", "")]
    cm, fake_cur = _patched_loader(rows)
    with cm:
        loader = DynamicPatternLoader(dsn="dsn-stub", ttl_seconds=60.0)
        loader.get_patterns()
        loader.get_patterns()
    # 2 execute calls per fetch (set_config + SELECT). 1 fetch total.
    assert fake_cur.execute.call_count == 2


def test_loader_invalidate_forces_refetch() -> None:
    rows = [("CMP", r"\bCMP-\d{4}\b", True, "global", "")]
    cm, fake_cur = _patched_loader(rows)
    with cm:
        loader = DynamicPatternLoader(dsn="dsn-stub", ttl_seconds=60.0)
        loader.get_patterns()
        loader.invalidate()
        loader.get_patterns()
    assert fake_cur.execute.call_count == 4  # two set_config + two SELECT


def test_loader_db_outage_returns_empty() -> None:
    import psycopg
    with patch(
        "services.litellm_redactor.dynamic_patterns.psycopg.connect",
        side_effect=psycopg.OperationalError("simulated"),
    ):
        loader = DynamicPatternLoader(dsn="dsn-stub")
        assert loader.get_patterns() == []


def test_loader_no_dsn_returns_empty() -> None:
    loader = DynamicPatternLoader(dsn=None)
    assert loader.get_patterns() == []
