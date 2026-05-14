"""Tests for the stub-encoder fail-loud guard in mcp_embedder._build_encoder."""

import importlib
import sys

import pytest


def _reload_main(monkeypatch, model_name: str, dev_mode: str | None):
    monkeypatch.setenv("EMBED_MODEL_NAME", model_name)
    if dev_mode is None:
        monkeypatch.delenv("CHEMCLAW_DEV_MODE", raising=False)
    else:
        monkeypatch.setenv("CHEMCLAW_DEV_MODE", dev_mode)
    # Force re-import so module-level _build_encoder() re-runs with the new env.
    sys.modules.pop("services.mcp_tools.mcp_embedder.main", None)
    sys.modules.pop("services.mcp_tools.mcp_embedder.settings", None)
    return importlib.import_module("services.mcp_tools.mcp_embedder.main")


def test_stub_encoder_refused_outside_dev_mode(monkeypatch):
    """Production deploy with embed_model_name=stub-encoder must refuse to start."""
    with pytest.raises(RuntimeError, match="stub-encoder"):
        _reload_main(monkeypatch, model_name="stub-encoder", dev_mode=None)


def test_stub_encoder_refused_when_dev_mode_false(monkeypatch):
    """CHEMCLAW_DEV_MODE=false (any non-'true' value) must also refuse."""
    with pytest.raises(RuntimeError, match="stub-encoder"):
        _reload_main(monkeypatch, model_name="stub-encoder", dev_mode="false")


def test_stub_encoder_allowed_when_dev_mode_true(monkeypatch):
    """CHEMCLAW_DEV_MODE=true is the documented escape hatch."""
    mod = _reload_main(monkeypatch, model_name="stub-encoder", dev_mode="true")
    # If we got here, _build_encoder did not raise.
    assert mod._encoder is not None
