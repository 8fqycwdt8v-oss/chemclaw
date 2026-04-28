"""Tests for env-driven config."""

from __future__ import annotations

from pathlib import Path

import pytest

from chemclaw_cli.config import load_config


def test_returns_defaults_when_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # The conftest sets these — clear them here to test true defaults.
    monkeypatch.delenv("CHEMCLAW_USER", raising=False)
    monkeypatch.delenv("CHEMCLAW_AGENT_URL", raising=False)
    monkeypatch.delenv("CHEMCLAW_CONFIG_DIR", raising=False)
    cfg = load_config()
    assert cfg.user == "dev@local.test"
    assert cfg.agent_url == "http://localhost:3101"
    assert cfg.config_dir == Path.home() / ".chemclaw"


def test_picks_up_env_overrides(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    monkeypatch.setenv("CHEMCLAW_AGENT_URL", "https://agent.staging:443")
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path))
    cfg = load_config()
    assert cfg.user == "alice@corp.test"
    assert cfg.agent_url == "https://agent.staging:443"
    assert cfg.config_dir == tmp_path


def test_strips_trailing_slash_from_agent_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHEMCLAW_AGENT_URL", "http://localhost:3101/")
    cfg = load_config()
    assert cfg.agent_url == "http://localhost:3101"
