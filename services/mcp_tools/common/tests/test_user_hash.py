"""Unit tests for services.mcp_tools.common.user_hash."""

from __future__ import annotations

import os

import pytest

from services.mcp_tools.common.user_hash import (
    DEFAULT_DEV_SALT,
    hash_user,
    reset_user_hash_for_tests,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    reset_user_hash_for_tests()
    os.environ.pop("LOG_USER_SALT", None)
    yield
    reset_user_hash_for_tests()
    os.environ.pop("LOG_USER_SALT", None)


def test_empty_input_returns_empty_string() -> None:
    assert hash_user("") == ""
    assert hash_user(None) == ""


def test_returns_16_hex_chars() -> None:
    assert len(hash_user("alice@example.com")) == 16
    assert all(c in "0123456789abcdef" for c in hash_user("alice@example.com"))


def test_deterministic_within_single_salt() -> None:
    os.environ["LOG_USER_SALT"] = "fixed-salt"
    reset_user_hash_for_tests()
    a = hash_user("alice@example.com")
    b = hash_user("alice@example.com")
    assert a == b


def test_changes_when_salt_changes() -> None:
    os.environ["LOG_USER_SALT"] = "salt-A"
    reset_user_hash_for_tests()
    with_a = hash_user("alice@example.com")
    os.environ["LOG_USER_SALT"] = "salt-B"
    reset_user_hash_for_tests()
    with_b = hash_user("alice@example.com")
    assert with_a != with_b


def test_does_not_contain_raw_input() -> None:
    raw = "alice@example.com"
    out = hash_user(raw)
    assert "alice" not in out
    assert "@" not in out


def test_default_dev_salt_used_without_env() -> None:
    # Sanity-check: with no env, the salt is the documented dev default.
    out_via_helper = hash_user("user")
    # Recompute manually with the same salt — they must agree.
    import hashlib

    expected = (
        hashlib.sha256(f"{DEFAULT_DEV_SALT}:user".encode()).hexdigest()[:16]
    )
    assert out_via_helper == expected


def test_throws_when_salt_unset_and_no_dev_signal(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mirror of the TS-side throw-path test.

    Pytest sets PYTEST_CURRENT_TEST automatically — `is_dev` is True
    inside any test by default. This case explicitly clears every
    dev-mode signal so the production fail-closed path actually fires,
    catching a future regression that flips the gate back to
    fail-open.
    """
    monkeypatch.delenv("LOG_USER_SALT", raising=False)
    monkeypatch.delenv("CHEMCLAW_DEV_MODE", raising=False)
    monkeypatch.delenv("MCP_AUTH_DEV_MODE", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    reset_user_hash_for_tests()
    with pytest.raises(RuntimeError, match=r"LOG_USER_SALT"):
        hash_user("alice@example.com")


def test_does_not_throw_when_dev_mode_true_and_salt_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LOG_USER_SALT", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("CHEMCLAW_DEV_MODE", "true")
    reset_user_hash_for_tests()
    # Falls back to the public dev salt — should produce a 16-hex hash
    # rather than throw. This is the local-dev path that must keep
    # working.
    out = hash_user("alice@example.com")
    assert len(out) == 16


def test_ts_python_parity_with_known_salt() -> None:
    """The TS hashUser and Python hash_user must agree on the same salt+input.

    This test pins the algorithm: sha256(salt || ":" || user)[:16].
    """
    os.environ["LOG_USER_SALT"] = "parity-test-salt"
    reset_user_hash_for_tests()
    import hashlib

    expected = (
        hashlib.sha256(b"parity-test-salt:bob@example.com").hexdigest()[:16]
    )
    assert hash_user("bob@example.com") == expected
