"""Smoke tests for the mcp-crest FastAPI app — does NOT invoke real CREST."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    # The auth middleware throws on startup if SERVICE_SCOPES doesn't match;
    # bind a dev-mode scope to keep tests hermetic.
    monkeypatch.setenv("MCP_AUTH_DEV_MODE", "true")
    monkeypatch.setattr(
        "services.mcp_tools.common.scopes.SERVICE_SCOPES",
        {"mcp-crest": "mcp_crest:invoke"},
        raising=False,
    )
    from services.mcp_tools.mcp_crest.main import app

    with TestClient(app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "mcp-crest"


def test_solvent_flag_validation():
    from services.mcp_tools.mcp_crest.main import _solvent_flags

    assert _solvent_flags("none", None) == []
    assert _solvent_flags("alpb", "water") == ["--alpb", "water"]
    assert _solvent_flags("gbsa", "dmso") == ["--gbsa", "dmso"]

    with pytest.raises(ValueError):
        _solvent_flags("alpb", None)
    with pytest.raises(ValueError):
        _solvent_flags("nonsense", "water")


def test_parse_ensemble_handles_multiblock():
    from services.mcp_tools.mcp_crest.main import _attach_boltzmann, _parse_ensemble

    text = (
        "3\n-1.0\n"
        "C 0 0 0\nC 1 0 0\nO 0 1 0\n"
        "3\n-0.99\n"
        "C 0 0 0\nC 1 0 0\nO 0 1 0\n"
    )
    parsed = _parse_ensemble(text, max_n=10)
    assert len(parsed) == 2
    assert parsed[0]["energy_hartree"] == -1.0
    weighted = _attach_boltzmann(parsed)
    assert sum(e["boltzmann_weight"] for e in weighted) == pytest.approx(1.0, rel=1e-6)
