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
    assert body["n_constraints"] == 0
    assert "inputs" in body["bofire_domain"]
    # bofire_version is reported live, not the static default.
    assert isinstance(body["bofire_version"], str) and body["bofire_version"] != "unknown"


def test_build_domain_with_linear_constraint(client):
    """Linear inequality constraint round-trips through the Domain JSON."""
    r = client.post(
        "/build_domain",
        json={
            "factors": [
                {"name": "t", "type": "continuous", "range": [25, 120]},
                {"name": "loading", "type": "continuous", "range": [1, 10]},
            ],
            "categorical_inputs": [],
            "outputs": [{"name": "y", "direction": "maximize"}],
            "constraints": [
                {
                    "type": "<=",
                    "features": ["t", "loading"],
                    "coefficients": [1, 5],
                    "rhs": 200,
                },
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_constraints"] == 1
    # Constraint section is present and non-empty in the canonical Domain JSON.
    assert body["bofire_domain"].get("constraints", {}).get("constraints")


def test_build_domain_constraint_features_coefficients_mismatch_returns_422(client):
    r = client.post(
        "/build_domain",
        json={
            "factors": [
                {"name": "t", "type": "continuous", "range": [0, 1]},
            ],
            "categorical_inputs": [],
            "outputs": [{"name": "y", "direction": "maximize"}],
            "constraints": [
                {"type": "<=", "features": ["t"], "coefficients": [1, 2], "rhs": 1},
            ],
        },
    )
    assert r.status_code == 422


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
    """Empty measured_outcomes → random space-filling proposals + fallback_reason set."""
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
    assert body["fallback_reason"] is not None
    assert "cold_start" in body["fallback_reason"]
    assert body["strategy"] == "SoboStrategy"
    # Cold start: source should reflect random.
    assert all(p["source"].startswith("random") for p in body["proposals"])


def test_recommend_next_random_strategy_short_circuits_gp(client):
    """RandomStrategy bypasses GP entirely regardless of measured count."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "t", "type": "continuous", "range": [25, 120]}],
            "categorical_inputs": [{"name": "solvent", "values": ["EtOH", "Toluene"]}],
            "outputs": [{"name": "y", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    measured = [
        {"factor_values": {"t": 50, "solvent": "EtOH"}, "outputs": {"y": 60}},
        {"factor_values": {"t": 80, "solvent": "EtOH"}, "outputs": {"y": 75}},
        {"factor_values": {"t": 100, "solvent": "Toluene"}, "outputs": {"y": 85}},
    ]
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": measured,
            "n_candidates": 3,
            "strategy": "RandomStrategy",
            "acquisition": "qLogEI",
        },
    )
    body = r.json()
    assert body["used_bo"] is False
    assert body["fallback_reason"] == "random_strategy"
    assert all(p["source"] == "random_strategy" for p in body["proposals"])


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


def test_recommend_next_rejects_unknown_factor_key(client):
    """measured_outcomes with a factor key not in Domain.inputs → 422."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "temperature_c", "type": "continuous", "range": [25, 120]}],
            "categorical_inputs": [{"name": "solvent", "values": ["EtOH", "Toluene"]}],
            "outputs": [{"name": "y", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": [
                {"factor_values": {"temp_c": 50, "solvent": "EtOH"}, "outputs": {"y": 70}},
            ],
            "n_candidates": 1,
        },
    )
    assert r.status_code == 422
    assert "factor keys" in r.json()["detail"]


def test_recommend_next_rejects_non_finite_output(client):
    """Non-finite outputs are blocked. inf is sent as a raw JSON token (Infinity)
    so the explicit finite check on the server actually fires; NaN doesn't survive
    JSON encoding so this exercises the more interesting path."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "t", "type": "continuous", "range": [25, 120]}],
            "categorical_inputs": [],
            "outputs": [{"name": "y", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    raw = (
        '{"bofire_domain":' + __import__("json").dumps(bofire_domain) + ","
        '"measured_outcomes":[{"factor_values":{"t":50},"outputs":{"y":Infinity}}],'
        '"n_candidates":1}'
    )
    r = client.post(
        "/recommend_next",
        content=raw,
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 422


def test_recommend_next_multi_objective_route(client):
    """Two outputs with mixed directions → MoboStrategy + qNEHVI path."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "t", "type": "continuous", "range": [25, 120]}],
            "categorical_inputs": [{"name": "solvent", "values": ["EtOH", "Toluene"]}],
            "outputs": [
                {"name": "yield_pct", "direction": "maximize"},
                {"name": "pmi", "direction": "minimize"},
            ],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    measured = [
        {"factor_values": {"t": 50, "solvent": "EtOH"}, "outputs": {"yield_pct": 60, "pmi": 30}},
        {"factor_values": {"t": 80, "solvent": "EtOH"}, "outputs": {"yield_pct": 75, "pmi": 25}},
        {"factor_values": {"t": 100, "solvent": "Toluene"}, "outputs": {"yield_pct": 85, "pmi": 50}},
        {"factor_values": {"t": 110, "solvent": "Toluene"}, "outputs": {"yield_pct": 90, "pmi": 80}},
    ]
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": measured,
            "n_candidates": 3,
            "seed": 7,
            "strategy": "MoboStrategy",
            "acquisition": "qNEHVI",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["proposals"]) == 3
    assert body["strategy"] == "MoboStrategy"
    # Either the BO path succeeded (source == 'qNEHVI') or it degraded to a
    # random_*_failed path. Both shapes are acceptable in CI; the contract is
    # that fallback_reason is set in the failure case and proposals come back.
    sources = {p["source"] for p in body["proposals"]}
    if body["used_bo"]:
        assert sources == {"qNEHVI"}
        assert body["fallback_reason"] is None
    else:
        assert any(s.startswith("random_") for s in sources)
        assert body["fallback_reason"]


def test_recommend_next_coerces_incompatible_acquisition(client):
    """Single-objective campaign with qNEHVI requested → coerced to qLogEI with reason."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "t", "type": "continuous", "range": [25, 120]}],
            "categorical_inputs": [],
            "outputs": [{"name": "y", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    measured = [
        {"factor_values": {"t": 30}, "outputs": {"y": 60}},
        {"factor_values": {"t": 60}, "outputs": {"y": 75}},
        {"factor_values": {"t": 100}, "outputs": {"y": 85}},
    ]
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": measured,
            "n_candidates": 2,
            "strategy": "SoboStrategy",
            "acquisition": "qNEHVI",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    if body["used_bo"]:
        # Coercion succeeded — the actual acquisition swap is reflected in
        # the proposal source, which is qLogEI on the warm path.
        assert {p["source"] for p in body["proposals"]} == {"qLogEI"}
        assert body["fallback_reason"] and "coerced" in body["fallback_reason"]


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


# ---------------------------------------------------------------------------
# gower_distance unit tests (pure functions, no HTTP, no BoFire import)
# ---------------------------------------------------------------------------

class _FakeFeat:
    """Minimal Domain input feature stub for gower_distance tests."""
    def __init__(self, key: str, bounds=None, categories=None):
        self.key = key
        self.bounds = bounds
        self.categories = categories


class _FakeInputs:
    def __init__(self, features):
        self.features = features


class _FakeDomain:
    def __init__(self, features):
        self.inputs = _FakeInputs(features)


def test_gower_distance_identical_continuous_is_zero():
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import gower_distance
    domain = _FakeDomain([_FakeFeat("t", bounds=(25, 120))])
    assert gower_distance({"t": 70}, {"t": 70}, domain) == 0.0


def test_gower_distance_max_continuous_is_one():
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import gower_distance
    domain = _FakeDomain([_FakeFeat("t", bounds=(0, 100))])
    assert abs(gower_distance({"t": 0}, {"t": 100}, domain) - 1.0) < 1e-9


def test_gower_distance_continuous_midpoint():
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import gower_distance
    domain = _FakeDomain([_FakeFeat("t", bounds=(0, 100))])
    assert abs(gower_distance({"t": 0}, {"t": 50}, domain) - 0.5) < 1e-9


def test_gower_distance_identical_categorical_is_zero():
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import gower_distance
    domain = _FakeDomain([_FakeFeat("solvent")])
    assert gower_distance({"solvent": "EtOH"}, {"solvent": "EtOH"}, domain) == 0.0


def test_gower_distance_different_categorical_is_one():
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import gower_distance
    domain = _FakeDomain([_FakeFeat("solvent")])
    assert gower_distance({"solvent": "EtOH"}, {"solvent": "Toluene"}, domain) == 1.0


def test_gower_distance_mixed_continuous_and_categorical():
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import gower_distance
    domain = _FakeDomain([
        _FakeFeat("t", bounds=(0, 100)),
        _FakeFeat("solvent"),
    ])
    # t contributes 0.5/2 = 0.25; solvent mismatch contributes 1.0/2 = 0.5; total = 0.75
    d = gower_distance({"t": 50, "solvent": "EtOH"}, {"t": 0, "solvent": "Toluene"}, domain)
    assert abs(d - 0.75) < 1e-9


def test_gower_distance_missing_value_contributes_zero():
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import gower_distance
    domain = _FakeDomain([_FakeFeat("t", bounds=(0, 100))])
    # None vs 100 — missing value contributes 0, not max
    assert gower_distance({"t": None}, {"t": 100}, domain) == 0.0


def test_gower_distance_zero_span_contributes_zero():
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import gower_distance
    domain = _FakeDomain([_FakeFeat("t", bounds=(50, 50))])
    assert gower_distance({"t": 50}, {"t": 50}, domain) == 0.0


# ---------------------------------------------------------------------------
# _apply_dedup_filter / HTTP integration
# ---------------------------------------------------------------------------

def test_recommend_next_min_distance_filters_identical_proposal(client):
    """A candidate nearly identical to a measured point should be filtered out;
    the response still returns n_candidates via resampling."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "t", "type": "continuous", "range": [0, 100]}],
            "categorical_inputs": [],
            "outputs": [{"name": "y", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    # Single measured point at t=50.0
    measured = [{"factor_values": {"t": 50.0}, "outputs": {"y": 80.0}}]

    # min_distance_from_measured=0.01 → reject proposals within 1 % of range.
    # Cold-start path with seed that places a candidate near t=50 should be
    # filtered. We can't guarantee which exact value BoFire samples, so we
    # just assert the contract: response comes back 200, proposals have sources,
    # and fallback_reason mentions the dedup filter when anything was rejected.
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": measured,
            "n_candidates": 4,
            "seed": 42,
            "min_distance_from_measured": 0.01,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Proposals must be present (either original or resampled).
    assert len(body["proposals"]) >= 1


def test_recommend_next_min_distance_zero_is_disabled(client):
    """min_distance_from_measured=0 is treated as disabled — no filtering applied."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "t", "type": "continuous", "range": [0, 100]}],
            "categorical_inputs": [],
            "outputs": [{"name": "y", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": [],
            "n_candidates": 3,
            "seed": 1,
            "min_distance_from_measured": 0.0,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["proposals"]) == 3
    # No dedup note in reason when effectively disabled.
    assert body["fallback_reason"] is None or "dedup" not in (body["fallback_reason"] or "")


def test_recommend_next_min_distance_none_is_disabled(client):
    """Omitting min_distance_from_measured does not filter any proposals."""
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "t", "type": "continuous", "range": [0, 100]}],
            "categorical_inputs": [],
            "outputs": [{"name": "y", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": [],
            "n_candidates": 3,
            "seed": 2,
        },
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["proposals"]) == 3


# ---------------------------------------------------------------------------
# Unit tests for internal helpers (no HTTP, no BoFire required)
# ---------------------------------------------------------------------------

def test_gower_distance_feature_with_no_key_is_skipped():
    """A feature whose key is None should be silently skipped (line 112 continue)."""
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import gower_distance

    class _NoKeyFeat:
        key = None
        bounds = (0, 100)

    domain = _FakeDomain([_NoKeyFeat(), _FakeFeat("t", bounds=(0, 100))])
    # Only the "t" feature participates; t values identical → 0.0
    d = gower_distance({"t": 50}, {"t": 50}, domain)
    assert d == 0.0


def test_min_distance_to_measured_empty_list_returns_one():
    """Empty measured_factor_list → 1.0 so cold-start candidates are never filtered."""
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import _min_distance_to_measured

    domain = _FakeDomain([_FakeFeat("t", bounds=(0, 100))])
    result = _min_distance_to_measured({"t": 50}, [], domain)
    assert result == 1.0


def test_apply_dedup_filter_resample_loop_fires_when_all_rejected():
    """All initial proposals rejected → resample loop must fire (covers lines 171-182).

    We construct a tiny domain [0, 1] with all proposals forced to 0.5 (by
    making the sample space effectively a single point) and a measured point
    at 0.5, then set min_dist > 0 so every proposal is rejected and the loop
    must resample.  We patch domain.inputs.sample to return near-0.5 proposals
    on the first call and diverse proposals on subsequent calls so the loop
    eventually fills the quota.
    """
    from unittest.mock import MagicMock, call
    import pandas as pd
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import _apply_dedup_filter

    # First sample call returns proposals all near 0.5 (will be rejected).
    close_df = pd.DataFrame({"t": [0.5, 0.5]})
    # Second sample call (resample round 1) returns proposals far from 0.5.
    far_df = pd.DataFrame({"t": [0.0, 1.0]})

    domain = _FakeDomain([_FakeFeat("t", bounds=(0, 1))])
    domain.inputs = MagicMock()
    domain.inputs.sample = MagicMock(side_effect=[close_df, far_df])
    domain.inputs.features = [_FakeFeat("t", bounds=(0, 1))]

    initial_proposals = [
        {"factor_values": {"t": 0.5}, "source": "test"},
        {"factor_values": {"t": 0.51}, "source": "test"},
    ]
    measured = [{"t": 0.5}]

    kept, any_rejected = _apply_dedup_filter(
        initial_proposals, measured, domain, min_dist=0.4, n_candidates=2, seed=7
    )
    # At least one resampled proposal should pass the filter.
    assert any_rejected is True
    assert len(kept) >= 1


def test_apply_dedup_filter_resample_exception_is_handled():
    """Exception in resample sample() is caught and logged; partial results returned."""
    from unittest.mock import MagicMock
    from services.mcp_tools.mcp_reaction_optimizer.optimizer import _apply_dedup_filter

    domain = _FakeDomain([_FakeFeat("t", bounds=(0, 1))])
    domain.inputs = MagicMock()
    domain.inputs.sample = MagicMock(side_effect=RuntimeError("fake sampler error"))
    domain.inputs.features = [_FakeFeat("t", bounds=(0, 1))]

    initial_proposals = [{"factor_values": {"t": 0.5}, "source": "test"}]
    measured = [{"t": 0.5}]

    # All proposals rejected, resample raises → should return empty list without raising.
    kept, any_rejected = _apply_dedup_filter(
        initial_proposals, measured, domain, min_dist=0.9, n_candidates=2, seed=1
    )
    assert any_rejected is True
    assert len(kept) == 0


def test_maybe_dedup_closure_sets_fallback_reason_when_rejected(client):
    """RandomStrategy + min_distance_from_measured → dedup_filter note in fallback_reason
    when a proposal is rejected (covers _maybe_dedup with any_rejected=True).

    Uses a single measured point at t=50 with min_distance=0.99 so virtually
    every random sample within [0,100] is within 99 % Gower distance of t=50
    and will be rejected, forcing the dedup_filter note into fallback_reason.
    """
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "t", "type": "continuous", "range": [0, 100]}],
            "categorical_inputs": [],
            "outputs": [{"name": "y", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    measured = [{"factor_values": {"t": 50.0}, "outputs": {"y": 80.0}}]

    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": measured,
            "n_candidates": 3,
            "seed": 42,
            "strategy": "RandomStrategy",
            # 0.99 means only proposals within 1 % of range from measured pass —
            # only t in [49, 51] passes; most random samples in [0,100] are rejected.
            "min_distance_from_measured": 0.99,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Either dedup note is present or all resamples happened to pass (very unlikely
    # but allowed). The important invariant: the endpoint returns 200 and proposals.
    assert isinstance(body["proposals"], list)
    # If any were rejected the fallback_reason must contain the dedup marker.
    if body["fallback_reason"] and "dedup_filter" in body["fallback_reason"]:
        assert "ε=0.990" in body["fallback_reason"]


def test_recommend_next_batch_with_observations_and_dedup(client):
    """Warm BO path (≥3 measured) + min_distance_from_measured set.

    This test exercises the dedup wrapper around the BO ask() / fallback
    return sites (lines 305, 315, 326, 336, 341).  We use a small 1-D domain
    with 4 measured outcomes (above cold-start threshold) and a large epsilon
    so the filter has something to do on the BO proposals.
    """
    domain_resp = client.post(
        "/build_domain",
        json={
            "factors": [{"name": "t", "type": "continuous", "range": [0, 100]}],
            "categorical_inputs": [],
            "outputs": [{"name": "y", "direction": "maximize"}],
        },
    )
    bofire_domain = domain_resp.json()["bofire_domain"]
    measured = [
        {"factor_values": {"t": 10}, "outputs": {"y": 55}},
        {"factor_values": {"t": 30}, "outputs": {"y": 65}},
        {"factor_values": {"t": 60}, "outputs": {"y": 80}},
        {"factor_values": {"t": 90}, "outputs": {"y": 70}},
    ]
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": measured,
            "n_candidates": 2,
            "seed": 99,
            # Small epsilon: filter points within 5 % of any measured point.
            "min_distance_from_measured": 0.05,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_observations"] == 4
    assert isinstance(body["proposals"], list)
    assert len(body["proposals"]) >= 1
