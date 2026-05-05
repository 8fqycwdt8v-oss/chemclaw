"""Tests for mcp-reaction-optimizer."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_reaction_optimizer.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-reaction-optimizer"


def test_readyz(client):
    r = client.get("/readyz")
    assert r.status_code == 200


def test_build_domain_happy_path(client):
    r = client.post(
        "/build_domain",
        json={
            "factors": [
                {"name": "temperature_c", "type": "continuous", "range": [25, 120]},
                {"name": "loading_mol_pct", "type": "continuous", "range": [1, 10]},
            ],
            "categorical_inputs": [
                {"name": "solvent", "values": ["EtOH", "Toluene", "2-MeTHF"]},
            ],
            "outputs": [{"name": "yield_pct", "direction": "maximize"}],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_inputs"] == 3
    assert body["n_outputs"] == 1
    assert "inputs" in body["bofire_domain"]


def test_build_domain_no_inputs_returns_422(client):
    r = client.post(
        "/build_domain",
        json={
            "factors": [],
            "categorical_inputs": [],
            "outputs": [{"name": "yield_pct", "direction": "maximize"}],
        },
    )
    assert r.status_code == 422


def test_recommend_next_cold_start_returns_random(client):
    """Empty measured_outcomes → random space-filling proposals."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "temperature_c", "type": "continuous", "range": [25, 120]}],
            "categorical_inputs": [{"name": "solvent", "values": ["EtOH", "Toluene"]}],
            "outputs": [{"name": "yield_pct", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]

    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": [],
            "n_candidates": 5,
            "seed": 42,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["proposals"]) == 5
    assert body["n_observations"] == 0
    assert body["used_bo"] is False
    # Cold start: source should reflect random.
    assert all(
        p["source"].startswith("random") for p in body["proposals"]
    )


def test_recommend_next_with_observations(client):
    """≥3 measured outcomes → either BO or fallback (both are valid; test the contract)."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "temperature_c", "type": "continuous", "range": [25, 120]}],
            "categorical_inputs": [{"name": "solvent", "values": ["EtOH", "Toluene"]}],
            "outputs": [{"name": "yield_pct", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]

    measured = [
        {"factor_values": {"temperature_c": 50, "solvent": "EtOH"}, "outputs": {"yield_pct": 60}},
        {"factor_values": {"temperature_c": 80, "solvent": "Toluene"}, "outputs": {"yield_pct": 75}},
        {"factor_values": {"temperature_c": 100, "solvent": "EtOH"}, "outputs": {"yield_pct": 85}},
        {"factor_values": {"temperature_c": 110, "solvent": "Toluene"}, "outputs": {"yield_pct": 90}},
    ]
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": measured,
            "n_candidates": 3,
            "seed": 42,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["proposals"]) == 3
    assert body["n_observations"] == 4
    # Each proposal should have factor_values for both inputs.
    for p in body["proposals"]:
        assert "temperature_c" in p["factor_values"]
        assert "solvent" in p["factor_values"]


def test_recommend_next_invalid_domain_returns_422(client):
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": {"not": "a domain"},
            "measured_outcomes": [],
            "n_candidates": 3,
        },
    )
    assert r.status_code == 422
    assert "invalid_bofire_domain" in r.json().get("detail", "")


def test_domain_load_uses_model_validate_round_trip(client):
    """Direct unit-level coverage of `_domain_load` exercising the
    `Domain.model_validate` path. Pins the round-trip equivalence so a
    BoFire bump that breaks discriminated-union deserialization surfaces
    here, not in production via /recommend_next."""
    from services.mcp_tools.mcp_reaction_optimizer.main import (  # noqa: PLC0415
        _domain_dump,
        _domain_load,
    )

    # Build a domain via the production /build_domain endpoint so the
    # payload shape matches what's stored in optimization_campaigns and
    # later passed back into _domain_load by /recommend_next.
    built = client.post(
        "/build_domain",
        json={
            "factors": [
                {"name": "t", "type": "continuous", "range": [25, 120]},
            ],
            "categorical_inputs": [],
            "outputs": [{"name": "yield_pct", "direction": "maximize"}],
        },
    )
    assert built.status_code == 200, built.text
    payload = built.json()["bofire_domain"]

    # Round-trip through _domain_load → _domain_dump.
    reloaded = _domain_load(payload)
    redumped = _domain_dump(reloaded)
    assert redumped["inputs"] == payload["inputs"]
    assert redumped["outputs"] == payload["outputs"]
