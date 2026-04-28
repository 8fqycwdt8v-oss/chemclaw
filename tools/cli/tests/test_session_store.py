"""Tests for the per-user last-session file store."""

from __future__ import annotations

from pathlib import Path

import pytest

from chemclaw_cli.session_store import SessionStore


@pytest.fixture
def store(tmp_path: Path) -> SessionStore:
    return SessionStore(config_dir=tmp_path / "chemclaw")


def test_read_returns_none_when_no_file(store: SessionStore) -> None:
    assert store.read("alice@corp") is None


def test_write_then_read_roundtrip(store: SessionStore) -> None:
    store.write("alice@corp", "11111111-1111-1111-1111-111111111111")
    assert store.read("alice@corp") == "11111111-1111-1111-1111-111111111111"


def test_per_user_separation(store: SessionStore) -> None:
    store.write("alice@corp", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    store.write("bob@corp", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    alice = store.read("alice@corp")
    bob = store.read("bob@corp")
    assert alice is not None and alice.startswith("aaaa")
    assert bob is not None and bob.startswith("bbbb")


def test_overwrite(store: SessionStore) -> None:
    store.write("alice@corp", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    store.write("alice@corp", "cccccccc-cccc-cccc-cccc-cccccccccccc")
    val = store.read("alice@corp")
    assert val is not None and val.startswith("cccc")


def test_user_id_with_special_chars_does_not_traverse(store: SessionStore) -> None:
    """Non-alphanumeric characters must be sanitised to prevent
    accidental path traversal or filename collisions."""
    store.write("../../../etc/passwd", "abcd1234-abcd-1234-abcd-123412341234")
    assert store.read("../../../etc/passwd") == "abcd1234-abcd-1234-abcd-123412341234"
    # The stored file lives under the config dir, never above it.
    files = list(store.config_dir.rglob("*"))
    for f in files:
        assert store.config_dir in f.parents or f == store.config_dir


def test_dir_and_file_perms_are_owner_only(store: SessionStore) -> None:
    """Defense in depth: ~/.chemclaw is created 0o700, files 0o600."""
    store.write("alice@corp", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    dir_mode = store.config_dir.stat().st_mode & 0o777
    file_path = next(store.config_dir.glob("last-session-*"))
    file_mode = file_path.stat().st_mode & 0o777
    assert dir_mode == 0o700
    assert file_mode == 0o600
