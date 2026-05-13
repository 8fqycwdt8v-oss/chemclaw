"""HTTP endpoint tests for mcp-chrom-method-optimizer."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_chrom_method_optimizer.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


# Common payload — minimal viable build_domain request. Tanaka values
# are deliberately distinct on every axis so the happy path exercises a
# real CategoricalDescriptorInput rather than the constant-descriptor
# fallback to plain CategoricalInput.
DEFAULT_BUILD_REQUEST = {
    "gradient_scheme": "hold_ramp_hold",
    "column_choices":  ["BEH-C18", "Kinetex-EVO", "HSS-T3"],
    "column_descriptors": [
        [3.30, 1.480, 1.500, 0.420, 0.190, 0.290],
        [3.20, 1.470, 1.510, 0.460, 0.140, 0.310],
        [3.55, 1.490, 1.520, 0.430, 0.090, 0.410],
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


def test_build_domain_multi_segment(client):
    req = {**DEFAULT_BUILD_REQUEST, "gradient_scheme": "multi_segment", "n_segments": 3}
    r = client.post("/build_domain", json=req)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["gradient_scheme"] == "multi_segment"
    assert body["n_segments"] == 3
    # 8 gradient inputs (pctB_init + 3·(t,pctB) + t_hold_final) + column
    # + b_solvent + additive + flow + T = 13
    assert body["n_inputs"] == 13
    # 5 monotonicity constraints (2 time-chain + 3 %B-chain). Domain JSON
    # serialises constraints as {"type": "Constraints", "constraints": [...]}.
    assert len(body["bofire_domain"]["constraints"]["constraints"]) == 5


def test_build_domain_ternary_eluent(client):
    req = {**DEFAULT_BUILD_REQUEST, "eluent_mode": "ternary"}
    r = client.post("/build_domain", json=req)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["eluent_mode"] == "ternary"
    keys = {f["key"] for f in body["bofire_domain"]["inputs"]["features"]}
    assert "b_meoh_fraction" in keys
    assert "b_solvent" not in keys


def test_build_domain_unknown_eluent_mode_returns_422(client):
    req = {**DEFAULT_BUILD_REQUEST, "eluent_mode": "quaternary"}
    r = client.post("/build_domain", json=req)
    assert r.status_code == 422


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


def test_materialize_method_ternary_emits_meoh_mix_label(client):
    r = client.post(
        "/materialize_method",
        json={
            "factor_values": {
                "t_hold_init_min": 0.0,
                "pctB_init":       5.0,
                "t_grad_min":      8.0,
                "pctB_final":      95.0,
                "t_hold_final_min": 0.0,
                "column":          "BEH-C18",
                "b_meoh_fraction": 0.3,
                "additive":        "FA_0.1pct",
                "flow_mLmin":      0.4,
                "T_col_C":         40.0,
            },
            "gradient_scheme": "hold_ramp_hold",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["b_solvent"] == "MeCN:MeOH 70:30"


def test_materialize_method_multi_segment(client):
    r = client.post(
        "/materialize_method",
        json={
            "factor_values": {
                "pctB_init":        5.0,
                "t_break1_min":     2.0, "pctB_break1": 25.0,
                "t_break2_min":     6.0, "pctB_break2": 60.0,
                "t_break3_min":    10.0, "pctB_break3": 95.0,
                "t_hold_final_min": 1.0,
                "column":          "BEH-C18",
                "b_solvent":       "MeCN",
                "additive":        "FA_0.1pct",
                "flow_mLmin":      0.4,
                "T_col_C":         40.0,
            },
            "gradient_scheme": "multi_segment",
            "n_segments": 3,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["gradient_program"]) == 5
    assert body["total_runtime_min"] == 11.0


# ── /score_chromatogram (Phase 2 — live) ────────────────────────────────

def test_score_chromatogram_well_separated(client):
    r = client.post(
        "/score_chromatogram",
        json={
            "peaks": [
                {"rt_min": 2.0, "fwhm_min": 0.04},
                {"rt_min": 2.6, "fwhm_min": 0.04},
                {"rt_min": 3.4, "fwhm_min": 0.05},
            ],
            "rs_target": 1.5,
            "runtime_target_min": 8.0,
            "runtime_min": 5.0,
            "b_solvent": "MeCN",
            "flow_mLmin": 0.4,
            "avg_pctB": 50.0,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_peaks"] == 3
    assert body["min_resolution"] > 1.5
    assert body["resolution_target_met"] is True
    assert body["runtime_min"] == 5.0
    assert body["solvent_pmi_g"] > 0
    assert body["tracking_confidence"] == "high"


def test_score_chromatogram_with_targets_partial_confidence(client):
    r = client.post(
        "/score_chromatogram",
        json={
            "peaks": [{"rt_min": 2.0, "name": "API", "fwhm_min": 0.04}],
            "targets": [{"name": "API"}, {"name": "Impurity B", "m_z": 333.1}],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tracking_confidence"] == "partial"
    assert body["unmatched_targets"] == ["Impurity B"]


# ── /extract_pareto (Phase 3) ───────────────────────────────────────────

def test_extract_pareto_returns_non_dominated_set(client):
    measured = [
        {"factor_values": {"a": 1}, "outputs": {"min_resolution": 2.0, "runtime_min": 10.0, "solvent_pmi_g": 3.0}},
        {"factor_values": {"a": 2}, "outputs": {"min_resolution": 2.5, "runtime_min": 8.0,  "solvent_pmi_g": 2.5}},  # dominates #1
        {"factor_values": {"a": 3}, "outputs": {"min_resolution": 1.8, "runtime_min": 5.0,  "solvent_pmi_g": 1.0}},  # non-dominated (fastest/greenest)
    ]
    r = client.post(
        "/extract_pareto",
        json={
            "measured_outcomes": measured,
            "output_directions": {"min_resolution": "maximize", "runtime_min": "minimize", "solvent_pmi_g": "minimize"},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_total"] == 3
    assert body["n_pareto"] == 2
    fronts = {item["factor_values"]["a"] for item in body["pareto"]}
    assert fronts == {2, 3}


def test_extract_pareto_bad_direction_returns_422(client):
    r = client.post(
        "/extract_pareto",
        json={
            "measured_outcomes": [{"factor_values": {}, "outputs": {"x": 1.0}}],
            "output_directions": {"x": "biggest"},
        },
    )
    assert r.status_code == 422


# ── /simulate_retention + /seed_candidates_lss (Phase 5) ────────────────

def _isocratic_obs(log10_kw: float, S: float, t0: float):
    obs = []
    for phi in (0.2, 0.4, 0.6):
        k = 10.0 ** (log10_kw - S * phi)
        obs.append([phi, t0 * (1.0 + k)])
    return obs


def test_simulate_retention_from_scouting_observations(client):
    t0 = 1.0
    r = client.post(
        "/simulate_retention",
        json={
            "scouting_observations": {
                "A": _isocratic_obs(2.0, 4.0, t0),
                "B": _isocratic_obs(2.2, 4.0, t0),
            },
            "gradient_program": [
                {"time_min": 0.0,  "pctB": 5.0},
                {"time_min": 12.0, "pctB": 95.0},
                {"time_min": 14.0, "pctB": 95.0},
            ],
            "t0_min": t0,
            "rs_target": 1.5,
            "runtime_target_min": 14.0,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_analytes"] == 2
    assert body["n_eluted"] == 2
    assert {p["name"] for p in body["peaks"]} == {"A", "B"}
    assert body["min_resolution"] >= 0.0
    # fitted params close to ground truth
    assert body["lss_by_analyte"]["A"][0] == pytest.approx(2.0, rel=1e-3)


def test_simulate_retention_requires_lss_or_scouting(client):
    r = client.post(
        "/simulate_retention",
        json={
            "gradient_program": [{"time_min": 0.0, "pctB": 5.0}, {"time_min": 5.0, "pctB": 95.0}],
            "t0_min": 1.0,
        },
    )
    assert r.status_code == 422


def test_seed_candidates_lss_ranks_by_simulated_crf(client):
    t0 = 1.0
    # Candidate gradients: a fast steep one and a slow shallow one. With
    # well-separated analytes, the steeper/faster one should score higher
    # (resolution_term ~equal, time bonus favours fast).
    candidates = [
        {"pctB_init": 5.0, "t_grad_min": 5.0,  "pctB_final": 95.0, "t_hold_final_min": 0.0,
         "t_hold_init_min": 0.0},
        {"pctB_init": 5.0, "t_grad_min": 25.0, "pctB_final": 95.0, "t_hold_final_min": 0.0,
         "t_hold_init_min": 0.0},
    ]
    r = client.post(
        "/seed_candidates_lss",
        json={
            "lss_by_analyte": {"A": [1.8, 4.0], "B": [2.6, 4.5]},
            "candidate_factor_values": candidates,
            "gradient_scheme": "hold_ramp_hold",
            "t0_min": t0,
            "top_k": 2,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_scored"] == 2
    assert body["n_analytes"] == 2
    assert len(body["ranked"]) == 2
    # Sorted descending by simulated_crf.
    assert body["ranked"][0]["simulated_crf"] >= body["ranked"][1]["simulated_crf"]
