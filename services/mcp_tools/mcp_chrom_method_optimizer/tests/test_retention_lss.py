"""Tests for the LSS retention simulator (Phase 5). Pure functions."""
from __future__ import annotations

import math

import pytest

from services.mcp_tools.mcp_chrom_method_optimizer import retention_lss as _lss


def test_fit_lss_isocratic_recovers_known_parameters():
    # Ground truth: log10 k_w = 2.0, S = 4.0, t0 = 1.0 min.
    log10_kw, S, t0 = 2.0, 4.0, 1.0
    obs = []
    for phi in (0.2, 0.4, 0.6):
        k = 10.0 ** (log10_kw - S * phi)
        tr = t0 * (1.0 + k)
        obs.append((phi, tr))
    fitted = _lss.fit_lss_isocratic(obs, t0_min=t0)
    assert fitted is not None
    fkw, fS = fitted
    assert fkw == pytest.approx(log10_kw, rel=1e-6)
    assert fS == pytest.approx(S, rel=1e-6)


def test_fit_lss_underdetermined_returns_none():
    # Only one distinct phi → can't fit a line.
    assert _lss.fit_lss_isocratic([(0.3, 5.0), (0.3, 5.1)], t0_min=1.0) is None


def test_fit_lss_unretained_peak_excluded():
    # A peak at t_R ≤ t0 has k ≤ 0; with only one other point left → None.
    assert _lss.fit_lss_isocratic([(0.5, 0.9), (0.7, 1.5)], t0_min=1.0) is None


def test_phi_interpolation_clamps_and_interpolates():
    gp = [
        {"time_min": 0.0,  "pctB": 5.0},
        {"time_min": 10.0, "pctB": 95.0},
        {"time_min": 12.0, "pctB": 95.0},
    ]
    assert _lss._phi_at(gp, -1.0) == pytest.approx(0.05)
    assert _lss._phi_at(gp, 5.0) == pytest.approx(0.50)   # midway → 50 %B
    assert _lss._phi_at(gp, 100.0) == pytest.approx(0.95)


def test_isocratic_gradient_program_reproduces_isocratic_retention():
    # A flat "gradient" at phi=0.4 should give t_R = t0·(1+k).
    log10_kw, S, t0 = 2.0, 4.0, 1.0
    phi = 0.4
    k = 10.0 ** (log10_kw - S * phi)
    expected_tr = t0 * (1.0 + k)
    gp = [{"time_min": 0.0, "pctB": phi * 100}, {"time_min": 60.0, "pctB": phi * 100}]
    tr = _lss.simulate_retention_gradient(log10_kw, S, gp, t0, march_step_min=0.001)
    assert tr is not None
    assert tr == pytest.approx(expected_tr, rel=2e-2)


def test_gradient_elutes_faster_than_initial_isocratic():
    # Under a rising gradient, t_R should be shorter than the isocratic t_R
    # at the initial %B (the analyte gets pushed off as %B climbs).
    log10_kw, S, t0 = 3.0, 5.0, 0.8
    phi0 = 0.05
    k0 = 10.0 ** (log10_kw - S * phi0)
    iso_tr_at_phi0 = t0 * (1.0 + k0)
    gp = [
        {"time_min": 0.0,  "pctB": 5.0},
        {"time_min": 15.0, "pctB": 95.0},
        {"time_min": 17.0, "pctB": 95.0},
    ]
    tr = _lss.simulate_retention_gradient(log10_kw, S, gp, t0, march_step_min=0.005)
    assert tr is not None
    assert tr < iso_tr_at_phi0


def test_non_eluting_analyte_returns_none():
    # Huge log10_kw, low %B ceiling → never migrates within the cap.
    gp = [{"time_min": 0.0, "pctB": 1.0}, {"time_min": 5.0, "pctB": 2.0}]
    tr = _lss.simulate_retention_gradient(
        9.0, 0.1, gp, t0_min=1.0, march_step_min=0.05, max_march_min=2.0,
    )
    assert tr is None


def test_peak_width_estimate_scales_with_rt_and_plates():
    w_low_N = _lss.estimate_peak_width_min(10.0, t0_min=1.0, plate_count=2_500)
    w_high_N = _lss.estimate_peak_width_min(10.0, t0_min=1.0, plate_count=40_000)
    # 4σ = 4·t_R/√N → more plates ⇒ narrower.
    assert w_low_N > w_high_N
    assert w_high_N == pytest.approx(4.0 * 10.0 / math.sqrt(40_000), rel=1e-9)


def test_simulate_chromatogram_sorts_and_drops_non_eluters():
    lss = {
        "fast":   (1.5, 4.0),     # elutes early
        "slow":   (3.0, 4.0),     # elutes later
        "stuck":  (12.0, 0.1),    # never elutes within the cap
    }
    gp = [
        {"time_min": 0.0,  "pctB": 5.0},
        {"time_min": 12.0, "pctB": 95.0},
        {"time_min": 14.0, "pctB": 95.0},
    ]
    peaks = _lss.simulate_chromatogram(lss, gp, t0_min=1.0)
    names = [p["name"] for p in peaks]
    assert "stuck" not in names
    rts = [p["rt_min"] for p in peaks]
    assert rts == sorted(rts)            # output is sorted by retention time
    assert names == ["fast", "slow"]     # which, with these params, is name order
    for p in peaks:
        assert p["width_baseline_min"] > 0
