"""HTTP endpoint tests for mcp-chrom-method-optimizer."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_chrom_method_optimizer.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


# Common payload — minimal viable build_domain request
DEFAULT_BUILD_REQUEST = {
    "gradient_scheme": "hold_ramp_hold",
    "column_choices":  ["BEH-C18", "Kinetex-EVO"],
    "column_descriptors": [
        [3.30, 1.480, 1.500, 0.420, 0.190, 0.290],
        [3.20, 1.480, 1.510, 0.460, 0.140, 0.310],
    ],
    "b_solvent_choices": ["MeCN", "MeOH"],
    "additive_choices":  ["FA_0.1pct", "TFA_0.1pct"],
    "flow_bounds_mLmin": [0.2, 0.6],
    "T_bounds_C":        [25.0, 50.0],
}


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-chrom-method-optimizer"


def test_readyz(client):
    r = client.get("/readyz")
    assert r.status_code == 200


def test_build_domain_happy_path(client):
    r = client.post("/build_domain", json=DEFAULT_BUILD_REQUEST)
    assert r.status_code == 200, r.text
    body = r.json()
    # 5 gradient continuous + column descriptor + b_solvent + additive
    # + flow + T_col_C = 10 inputs total
    assert body["n_inputs"] == 10
    assert body["n_outputs"] == 1
    assert body["gradient_scheme"] == "hold_ramp_hold"
    assert body["objective_mode"] == "single"
    assert "inputs" in body["bofire_domain"]
    assert "constraints" in body["bofire_domain"]


def test_build_domain_pareto_three_outputs(client):
    req = {**DEFAULT_BUILD_REQUEST, "objective_mode": "pareto"}
    r = client.post("/build_domain", json=req)
    assert r.status_code == 200, r.text
    assert r.json()["n_outputs"] == 3


def test_build_domain_descriptor_mismatch_returns_422(client):
    bad = {
        **DEFAULT_BUILD_REQUEST,
        "column_descriptors": [[1.0, 2.0], [3.0, 4.0]],   # too few descriptors
    }
    r = client.post("/build_domain", json=bad)
    assert r.status_code == 422
    assert "Tanaka" in r.text or "descriptor" in r.text


def test_build_domain_multi_segment_returns_501(client):
    req = {**DEFAULT_BUILD_REQUEST, "gradient_scheme": "multi_segment"}
    r = client.post("/build_domain", json=req)
    assert r.status_code == 501


def test_build_domain_unknown_scheme_returns_422(client):
    req = {**DEFAULT_BUILD_REQUEST, "gradient_scheme": "spline"}
    r = client.post("/build_domain", json=req)
    assert r.status_code == 422


def test_recommend_next_cold_start(client):
    domain_resp = client.post("/build_domain", json=DEFAULT_BUILD_REQUEST)
    bofire_domain = domain_resp.json()["bofire_domain"]

    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": [],
            "n_candidates": 6,
            "seed": 42,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["proposals"]) == 6
    assert body["n_observations"] == 0
    assert body["used_bo"] is False
    assert all(p["source"].startswith("random") for p in body["proposals"])


def test_recommend_next_proposal_keys_match_domain(client):
    """Cold-start proposals must include all 10 input factor keys."""
    domain_resp = client.post("/build_domain", json=DEFAULT_BUILD_REQUEST)
    bofire_domain = domain_resp.json()["bofire_domain"]

    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": [],
            "n_candidates": 2,
            "seed": 0,
        },
    )
    assert r.status_code == 200
    proposal = r.json()["proposals"][0]["factor_values"]
    expected_keys = {
        "t_hold_init_min", "pctB_init", "t_grad_min", "pctB_final", "t_hold_final_min",
        "column", "b_solvent", "additive", "flow_mLmin", "T_col_C",
    }
    assert expected_keys <= set(proposal.keys())


def test_recommend_next_invalid_domain_returns_422(client):
    r = client.post(
        "/recommend_next",
        json={
            "bofire_domain": {"not": "a real domain"},
            "measured_outcomes": [],
            "n_candidates": 2,
        },
    )
    assert r.status_code == 422


def test_materialize_method_emits_executable_program(client):
    r = client.post(
        "/materialize_method",
        json={
            "factor_values": {
                "t_hold_init_min": 0.5,
                "pctB_init":       5.0,
                "t_grad_min":      8.0,
                "pctB_final":      95.0,
                "t_hold_final_min": 1.5,
                "column":          "BEH-C18",
                "b_solvent":       "MeCN",
                "additive":        "FA_0.1pct",
                "flow_mLmin":      0.4,
                "T_col_C":         40.0,
            },
            "gradient_scheme": "hold_ramp_hold",
            "detection_mode":  "DAD",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["column"] == "BEH-C18"
    assert body["b_solvent"] == "MeCN"
    assert body["flow_mLmin"] == pytest.approx(0.4)
    assert body["total_runtime_min"] == pytest.approx(10.0)
    assert len(body["gradient_program"]) == 4
    assert body["gradient_program"][0] == {"time_min": 0.0, "pctB": 5.0}


def test_materialize_method_missing_factor_returns_422(client):
    r = client.post(
        "/materialize_method",
        json={
            "factor_values": {"pctB_init": 5.0},   # missing most fields
            "gradient_scheme": "hold_ramp_hold",
        },
    )
    assert r.status_code == 422


def test_score_chromatogram_returns_501(client):
    r = client.post("/score_chromatogram", json={"peaks": []})
    assert r.status_code == 501
