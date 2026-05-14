"""Tests for the stub-encoder fail-loud guard in mcp_embedder._build_encoder.

The guard runs at module-import time (services/mcp_tools/mcp_embedder/main.py
calls `_encoder = _build_encoder()` at the bottom of the module), so the tests
force a re-import via `monkeypatch.delitem(sys.modules, ...)` — this ensures
pytest tears down the cached modules after each test, preventing state leakage
into any downstream test that imports `services.mcp_tools.mcp_embedder.main`.
"""

import importlib
import sys

import pytest

from services.mcp_tools.mcp_embedder.encoder import StubEncoder


def _reload_main(monkeypatch, model_name: str, dev_mode: str | None):
    monkeypatch.setenv("EMBED_MODEL_NAME", model_name)
    if dev_mode is None:
        monkeypatch.delenv("CHEMCLAW_DEV_MODE", raising=False)
    else:
        monkeypatch.setenv("CHEMCLAW_DEV_MODE", dev_mode)
    # Use monkeypatch.delitem so the entries are restored on teardown — pop()
    # alone would leak the test's modified module into sys.modules for the
    # rest of the pytest invocation.
    monkeypatch.delitem(sys.modules, "services.mcp_tools.mcp_embedder.main", raising=False)
    monkeypatch.delitem(sys.modules, "services.mcp_tools.mcp_embedder.settings", raising=False)
    return importlib.import_module("services.mcp_tools.mcp_embedder.main")


def test_stub_encoder_refused_outside_dev_mode(monkeypatch):
    """Production deploy with embed_model_name=stub-encoder must refuse to start."""
    with pytest.raises(RuntimeError, match=r"stub-encoder.*CHEMCLAW_DEV_MODE"):
        _reload_main(monkeypatch, model_name="stub-encoder", dev_mode=None)


def test_stub_encoder_refused_when_dev_mode_false(monkeypatch):
    """CHEMCLAW_DEV_MODE=false (any non-'true' value) must also refuse."""
    with pytest.raises(RuntimeError, match=r"stub-encoder.*CHEMCLAW_DEV_MODE"):
        _reload_main(monkeypatch, model_name="stub-encoder", dev_mode="false")


def test_stub_encoder_allowed_when_dev_mode_true(monkeypatch):
    """CHEMCLAW_DEV_MODE=true is the documented escape hatch."""
    mod = _reload_main(monkeypatch, model_name="stub-encoder", dev_mode="true")
    assert isinstance(mod._encoder, StubEncoder)
