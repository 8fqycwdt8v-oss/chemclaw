"""Tests for the Niezen-Desmet CRF scorer (Phase 2). Pure functions."""
from __future__ import annotations

import pytest

from services.mcp_tools.mcp_chrom_method_optimizer import scorer as _s


def _gauss_peak(rt: float, area: float, sigma: float, **extra):
    """Gaussian peak: height back-out so _peak_width_baseline_min → 4σ."""
    import math
    height = area / (sigma * math.sqrt(2.0 * math.pi))
    return {"rt_min": rt, "area": area, "height": height, **extra}


def test_resolution_well_separated_pair():
    peaks = [
        _gauss_peak(2.0, 100.0, 0.02),
        _gauss_peak(2.5, 100.0, 0.02),
    ]
    out = _s.score_chromatogram(peaks, rs_target=1.5)
    # ΔtR = 0.5, w1+w2 = 4σ·2 = 0.16 → Rs = 2·0.5/0.16 = 6.25
    assert out["resolutions"][0] == pytest.approx(6.25, rel=1e-3)
    assert out["min_resolution"] == pytest.approx(6.25, rel=1e-3)
    assert out["resolution_target_met"] is True
    assert out["n_peaks"] == 2


def test_resolution_capped_in_crf_no_reward_for_over_resolution():
    # Two pairs, both massively over-resolved → resolution_term ≤ n_pairs.
    peaks = [_gauss_peak(t, 100.0, 0.01) for t in (1.0, 3.0, 5.0)]
    out = _s.score_chromatogram(peaks, rs_target=1.5, runtime_target_min=8.0)
    # 2 pairs, each min(Rs/1.5,1)=1 → resolution_term=2; f=1 so λ=λ_max=1;
    # time_term=(8-5)/8=0.375; peak_bonus 0.1·3=0.3 → CRF ≈ 2 + 0.375 + 0.3
    assert out["crf_total"] == pytest.approx(2.675, rel=1e-3)


def test_unresolved_pair_kills_min_resolution_and_zeros_time_weight():
    # A near-coeluting pair: Rs ~ 0.2. λ ~ 0 so the (negative) time term
    # barely affects CRF — the optimizer should focus on resolving.
    peaks = [
        _gauss_peak(2.00, 100.0, 0.10),
        _gauss_peak(2.04, 100.0, 0.10),
        _gauss_peak(6.00, 100.0, 0.05),
    ]
    out = _s.score_chromatogram(peaks, rs_target=1.5, runtime_target_min=2.0)
    assert out["min_resolution"] < 0.5
    assert out["resolution_target_met"] is False
    # f ≈ Rs_min/1.5 small → λ ≈ f^3 ≈ ~0 → CRF dominated by resolution_term
    # + peak_bonus, NOT by the big negative time penalty (runtime 6 > target 2).
    assert out["crf_total"] > 0.0


def test_single_peak_is_degenerate_zero_resolution():
    out = _s.score_chromatogram([_gauss_peak(3.0, 100.0, 0.02)], rs_target=1.5)
    assert out["resolutions"] == []
    assert out["min_resolution"] == 0.0
    assert out["n_peaks"] == 1


def test_runtime_explicit_overrides_last_peak_rt():
    peaks = [_gauss_peak(2.0, 100.0, 0.02), _gauss_peak(2.5, 100.0, 0.02)]
    out = _s.score_chromatogram(peaks, runtime_min=12.0)
    assert out["runtime_min"] == 12.0


def test_solvent_pmi_estimate():
    peaks = [_gauss_peak(2.0, 100.0, 0.02), _gauss_peak(2.5, 100.0, 0.02)]
    out = _s.score_chromatogram(
        peaks, runtime_min=10.0, b_solvent="MeCN", flow_mLmin=0.4, avg_pctB=50.0,
    )
    # 0.4 mL/min · 10 min · 0.786 g/mL · 0.5 · (1+0.75) = 2.7510 g
    assert out["solvent_pmi_g"] == pytest.approx(2.7510, rel=1e-3)


def test_noise_peaks_below_area_fraction_dropped():
    peaks = [
        _gauss_peak(2.0, 1000.0, 0.02),
        _gauss_peak(2.5, 1.0, 0.02),     # 0.1% of the main peak → noise
        _gauss_peak(3.0, 1000.0, 0.02),
    ]
    out = _s.score_chromatogram(peaks, min_area_fraction=0.005)
    assert out["n_peaks"] == 2


def test_fwhm_width_field_is_used():
    peaks = [
        {"rt_min": 2.0, "fwhm_min": 0.05},
        {"rt_min": 2.5, "fwhm_min": 0.05},
    ]
    out = _s.score_chromatogram(peaks)
    # baseline width = fwhm·(4/2.3548) = 0.05·1.6986 = 0.08493 each;
    # Rs = 2·0.5 / (2·0.08493) = 5.887
    assert out["resolutions"][0] == pytest.approx(5.887, rel=1e-2)


# ── Ternary solvent PMI (Fix #8) ────────────────────────────────────────

def test_pmi_uses_weighted_density_in_ternary_mode():
    peaks = [_gauss_peak(2.0, 100.0, 0.02), _gauss_peak(2.5, 100.0, 0.02)]
    # x_meoh = 1.0 → pure MeOH (ρ = 0.792). Same flow / runtime / avg_pctB.
    pure_meoh = _s.score_chromatogram(
        peaks, runtime_min=10.0, flow_mLmin=0.4, avg_pctB=50.0,
        b_meoh_fraction=1.0,
    )
    # x_meoh = 0.0 → pure MeCN (ρ = 0.786).
    pure_mecn = _s.score_chromatogram(
        peaks, runtime_min=10.0, flow_mLmin=0.4, avg_pctB=50.0,
        b_meoh_fraction=0.0,
    )
    assert pure_meoh["solvent_pmi_g"] > pure_mecn["solvent_pmi_g"]
    # Mix at x=0.5 should sit between the pure values.
    mix = _s.score_chromatogram(
        peaks, runtime_min=10.0, flow_mLmin=0.4, avg_pctB=50.0,
        b_meoh_fraction=0.5,
    )
    assert pure_mecn["solvent_pmi_g"] < mix["solvent_pmi_g"] < pure_meoh["solvent_pmi_g"]


def test_pmi_b_meoh_overrides_b_solvent_lookup():
    """When b_meoh_fraction is set, it takes precedence over a string match."""
    peaks = [_gauss_peak(2.0, 100.0, 0.02), _gauss_peak(2.5, 100.0, 0.02)]
    # b_solvent string says MeCN (0.786) but x_meoh=1.0 should win → 0.792.
    overridden = _s.score_chromatogram(
        peaks, runtime_min=10.0, flow_mLmin=0.4, avg_pctB=50.0,
        b_solvent="MeCN", b_meoh_fraction=1.0,
    )
    pure_meoh = _s.score_chromatogram(
        peaks, runtime_min=10.0, flow_mLmin=0.4, avg_pctB=50.0,
        b_solvent="MeOH",
    )
    assert overridden["solvent_pmi_g"] == pytest.approx(pure_meoh["solvent_pmi_g"], rel=1e-6)


# ── Adversarial CRF: pathologies must rank below reasonable methods ─────

def test_collapsed_peak_pathology_scores_below_resolved():
    """A method that fuses three peaks into one broad peak must NOT win
    against a method that resolves them — the cap on resolution_term plus
    the peak_bonus per resolved peak makes this fail-safe."""
    collapsed = [_gauss_peak(3.0, 300.0, 0.30)]              # one fat peak
    resolved = [
        _gauss_peak(2.0, 100.0, 0.02),
        _gauss_peak(2.6, 100.0, 0.02),
        _gauss_peak(3.4, 100.0, 0.02),
    ]
    s_col = _s.score_chromatogram(collapsed, rs_target=1.5)
    s_res = _s.score_chromatogram(resolved, rs_target=1.5)
    assert s_res["crf_total"] > s_col["crf_total"]
    assert s_res["min_resolution"] > s_col["min_resolution"]


def test_dead_volume_dumping_pathology_does_not_win():
    """All peaks dumped at the void volume (no separation) scores below a
    properly-resolved gradient even if the runtime is shorter."""
    dumped = [
        _gauss_peak(1.0, 100.0, 0.02),
        _gauss_peak(1.0 + 0.01, 100.0, 0.02),
        _gauss_peak(1.0 + 0.02, 100.0, 0.02),
    ]
    resolved = [
        _gauss_peak(2.0, 100.0, 0.02),
        _gauss_peak(2.6, 100.0, 0.02),
        _gauss_peak(3.4, 100.0, 0.02),
    ]
    s_dump = _s.score_chromatogram(dumped, rs_target=1.5, runtime_target_min=8.0)
    s_res  = _s.score_chromatogram(resolved, rs_target=1.5, runtime_target_min=8.0)
    assert s_res["crf_total"] > s_dump["crf_total"]
    assert s_dump["resolution_target_met"] is False


def test_over_resolved_does_not_beat_well_resolved_with_faster_runtime():
    """Over-resolution beyond Rs_target gives no extra reward (capped); a
    method that hits the target faster should win."""
    slow_over = [_gauss_peak(t, 100.0, 0.05) for t in (5.0, 9.0, 13.0)]
    fast_at_target = [_gauss_peak(t, 100.0, 0.05) for t in (2.0, 2.6, 3.3)]
    s_slow = _s.score_chromatogram(slow_over, rs_target=1.5, runtime_target_min=8.0)
    s_fast = _s.score_chromatogram(fast_at_target, rs_target=1.5, runtime_target_min=8.0)
    assert s_fast["crf_total"] > s_slow["crf_total"]
