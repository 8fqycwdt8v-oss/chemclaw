"""Shared pytest fixtures for the chemclaw_cli test suite.

Every test gets:
  - CHEMCLAW_CONFIG_DIR pointed at a tmp_path (no real ~/.chemclaw writes).
  - CHEMCLAW_USER and CHEMCLAW_AGENT_URL pinned to known test values, so
    tests do not pick up developer env state.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "test@unit.local")
    monkeypatch.setenv("CHEMCLAW_AGENT_URL", "http://test.local:9999")
    yield
