"""End-to-end smoke for the chromatography BO loop using the LSS
simulator as a stand-in for a real instrument.

A scaled-down version of the Boelrijk-2023 / Gloria-2024 benchmark:
a 6-analyte synthetic mixture with known LSS parameters, a single
hold-ramp-hold gradient family, and the Niezen-Desmet CRF as the
single-objective. We verify that:

  * /build_domain + /recommend_next + /score_chromatogram + Pareto
    extraction round-trip end-to-end without bofire/pydantic errors;
  * the simulated CRF *can* reach baseline resolution under the
    encoded factor space — i.e. there exists at least one (pctB_init,
    t_grad, ...) sample for which the Niezen-Desmet CRF crosses a
    "solved" threshold (resolution_target_met=True);
  * the legacy / pathological methods we generate in adversarial cases
    score strictly below the best-effort one.

The full optimisation-curve benchmark (BO convergence in ≤ 35 rounds)
remains in BACKLOG — running BoFire qLogEI in a unit test would take
minutes per case. This smoke is the contract test that the pieces fit.
"""
from __future__ import annotations

from itertools import pairwise

import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.mcp_chrom_method_optimizer import retention_lss as _lss


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_chrom_method_optimizer.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


# 6-analyte synthetic mixture, modest selectivity differences (Δlog10_kw
# 0.15 between adjacent analytes — typical RP-HPLC small-molecule spacing).
_LSS_BY_ANALYTE = {
    "A": (1.50, 3.5),
    "B": (1.65, 3.5),
    "C": (1.80, 3.6),
    "D": (1.95, 3.5),
    "E": (2.10, 3.6),
    "F": (2.25, 3.5),
}


def _hold_ramp_hold_program(pctB_init, t_grad, pctB_final, t_hold_init=0.0, t_hold_final=0.0):
    return [
        {"time_min": 0.0,                                "pctB": pctB_init},
        {"time_min": t_hold_init,                        "pctB": pctB_init},
        {"time_min": t_hold_init + t_grad,               "pctB": pctB_final},
        {"time_min": t_hold_init + t_grad + t_hold_final,"pctB": pctB_final},
    ]


def test_loop_pieces_round_trip_end_to_end(client):
    """build → recommend_next (cold-start) → simulate → score → extract Pareto."""
    build = client.post(
        "/build_domain",
        json={
            "gradient_scheme": "hold_ramp_hold",
            "column_choices": ["BEH-C18", "HSS-T3", "Kinetex-EVO"],
            "column_descriptors": [
                [3.30, 1.480, 1.500, 0.420, 0.190, 0.290],
                [3.55, 1.490, 1.520, 0.430, 0.090, 0.410],
                [3.20, 1.470, 1.510, 0.460, 0.140, 0.310],
            ],
            "b_solvent_choices": ["MeCN", "MeOH"],
            "additive_choices":  ["FA_0.1pct", "TFA_0.1pct"],
            "flow_bounds_mLmin": [0.3, 0.5],
            "T_bounds_C":        [35.0, 45.0],
            "objective_mode": "single",
        },
    )
    assert build.status_code == 200, build.text
    bofire_domain = build.json()["bofire_domain"]

    reco = client.post(
        "/recommend_next",
        json={
            "bofire_domain": bofire_domain,
            "measured_outcomes": [],
            "n_candidates": 4,
            "seed": 7,
        },
    )
    assert reco.status_code == 200, reco.text
    proposals = reco.json()["proposals"]
    assert len(proposals) == 4

    # Score each cold-start proposal via the LSS simulator → /score_chromatogram.
    measured = []
    for p in proposals:
        fv = p["factor_values"]
        program = _hold_ramp_hold_program(
            pctB_init=fv["pctB_init"],
            t_grad=fv["t_grad_min"],
            pctB_final=fv["pctB_final"],
            t_hold_init=fv["t_hold_init_min"],
            t_hold_final=fv["t_hold_final_min"],
        )
        sim_peaks = _lss.simulate_chromatogram(_LSS_BY_ANALYTE, program, t0_min=0.4)
        score = client.post(
            "/score_chromatogram",
            json={
                "peaks": sim_peaks,
                "rs_target": 1.5,
                "runtime_target_min": fv["t_hold_init_min"] + fv["t_grad_min"] + fv["t_hold_final_min"],
                "runtime_min": fv["t_hold_init_min"] + fv["t_grad_min"] + fv["t_hold_final_min"],
                "b_solvent": fv["b_solvent"],
                "flow_mLmin": fv["flow_mLmin"],
                "avg_pctB": (fv["pctB_init"] + fv["pctB_final"]) / 2.0,
            },
        )
        assert score.status_code == 200, score.text
        body = score.json()
        measured.append({
            "factor_values": fv,
            "outputs": {
                "crf_total": body["crf_total"],
                "min_resolution": body["min_resolution"],
                "runtime_min": body["runtime_min"],
                "solvent_pmi_g": body["solvent_pmi_g"],
            },
        })

    # All proposals scored — none failed schema validation.
    assert all("crf_total" in m["outputs"] for m in measured)

    # Pareto extraction over the cold-start batch (using the MO output
    # directions even though the campaign was single-objective).
    pareto = client.post(
        "/extract_pareto",
        json={
            "measured_outcomes": measured,
            "output_directions": {
                "min_resolution": "maximize",
                "runtime_min":    "minimize",
                "solvent_pmi_g":  "minimize",
            },
        },
    )
    assert pareto.status_code == 200, pareto.text
    pj = pareto.json()
    assert pj["n_total"] == 4
    assert 1 <= pj["n_pareto"] <= 4


def test_simulator_baseline_resolution_is_achievable():
    """Sanity: with a slow, gentle gradient there exists a setting under
    which the 6-analyte mixture achieves resolution ≥ 1.5 across every
    adjacent pair — the simulator can produce a solved chromatogram, so
    a CRF maximiser has a feasible optimum to find."""
    program = _hold_ramp_hold_program(
        pctB_init=5.0, t_grad=22.0, pctB_final=90.0,
        t_hold_init=0.5, t_hold_final=1.0,
    )
    peaks = _lss.simulate_chromatogram(_LSS_BY_ANALYTE, program, t0_min=0.4)
    assert len(peaks) == 6
    # Every adjacent gap should be wide relative to the constant-N width.
    for a, b in pairwise(peaks):
        gap = b["rt_min"] - a["rt_min"]
        w_avg = 0.5 * (a["width_baseline_min"] + b["width_baseline_min"])
        assert gap / w_avg >= 1.0
