"""Chromatographic-response-function scoring for HPLC method optimization.

Pure functions: no I/O, no BoFire. Given a peak list from one chromatogram
(as produced by mcp-logs-sciy / a CDS export — each peak a dict with at
least ``rt_min`` plus enough shape info to estimate width) and a few
campaign-level targets, compute:

  - per-adjacent-pair resolution (USS / Gaussian-width estimate)
  - the minimum resolution across the critical pairs (the MO objective)
  - the total runtime
  - a solvent process-mass-intensity estimate
  - the Niezen-Desmet 2024 self-adaptive CRF (the SO objective)

Niezen-Desmet self-adaptive CRF
-------------------------------
Niezen, L.E.; Desmet, G. (2024). *A new chromatographic response function
with automatically adapting weight factor for automated method development.*
J. Chromatogr. A 1730, 465212. https://doi.org/10.1016/j.chroma.2024.465212

Idea: the time-penalty weight is a self-adapting function of how close the
separation is to "solved". While resolution targets are unmet the weight is
~0 (the optimizer should focus on resolving, not on speed); once met it
grows so the optimizer pushes for shorter runtime. We implement:

  resolution_term = Σ_pairs  min(Rs_i / Rs_target, 1)          # capped — no
                                                                # reward for
                                                                # over-resolving
  f               = min(Rs_min / Rs_target, 1)                 # "solvedness"
  λ               = λ_max · f^k                                 # k≥2 → stays
                                                                # near 0 until
                                                                # nearly solved
  time_term       = (t_target − t_R_last) / t_target            # +ve if faster
  CRF             = resolution_term + λ · time_term + peak_bonus

``peak_bonus`` is a small reward (0.1 per resolved peak above the detection
threshold) so a method that elutes *more* identifiable peaks at equal
resolution wins. This is the comprehensive-CRF posture (resolution × number
of peaks × analysis time) the paper advocates, with the self-adapting weight
removing the hand-tuned time coefficient that makes the legacy Berridge /
Watson-Carr CRFs reward-hack.
"""
from __future__ import annotations

import math
from itertools import pairwise
from typing import Any, Sequence

# Solvent density (g/mL) by B-solvent identity — for the PMI estimate.
_SOLVENT_DENSITY_G_PER_ML: dict[str, float] = {
    "MeCN": 0.786,
    "ACN": 0.786,
    "MeOH": 0.792,
    "IPA": 0.786,
    "2-PrOH": 0.786,
    "MeOH:MeCN_50:50": 0.789,
}
_DENSITY_MECN_G_PER_ML = 0.786
_DENSITY_MEOH_G_PER_ML = 0.792
_DENSITY_FALLBACK_G_PER_ML = 0.79
# Re-equilibration multiplier — total solvent ≈ runtime × (1 + this).
_REEQUIL_FACTOR = 0.75


def _resolve_b_solvent_density(
    b_solvent: str | None, b_meoh_fraction: float | None,
) -> float:
    """Density of the B-channel solvent in g/mL.

    In ternary mode the B-channel is a continuous MeCN/MeOH mix
    parameterised by `b_meoh_fraction ∈ [0, 1]` — its density is
    well-approximated by the linear weighting of pure-component densities
    (a < 1 % error vs. the measured Redlich-Kister-corrected mix density
    over this composition range — fine for a PMI estimate). Otherwise
    look up the categorical table; fall back to the rough 0.79 g/mL only
    when nothing matches.
    """
    if b_meoh_fraction is not None:
        x = max(0.0, min(1.0, float(b_meoh_fraction)))
        return (
            (1.0 - x) * _DENSITY_MECN_G_PER_ML
            + x * _DENSITY_MEOH_G_PER_ML
        )
    if b_solvent is None:
        return _DENSITY_FALLBACK_G_PER_ML
    return _SOLVENT_DENSITY_G_PER_ML.get(b_solvent, _DENSITY_FALLBACK_G_PER_ML)

# Default CRF knobs (callers may override).
DEFAULT_RS_TARGET = 1.5
DEFAULT_RUNTIME_TARGET_MIN = 8.0
DEFAULT_LAMBDA_MAX = 1.0
DEFAULT_LAMBDA_EXPONENT = 3.0
DEFAULT_PEAK_BONUS = 0.1
# Peaks with area below this fraction of the largest peak's area are treated
# as noise and excluded from the critical-pair set.
DEFAULT_MIN_AREA_FRACTION = 0.005


def _peak_width_baseline_min(peak: dict[str, Any]) -> float | None:
    """Estimate a peak's baseline width (4σ, in minutes).

    Preference order:
      1. explicit ``width_min`` / ``width_baseline_min`` field
      2. ``fwhm_min`` → baseline = fwhm / 1.177  · 4 / (2.355) ... actually
         baseline(4σ) = fwhm · (4 / 2.3548) = fwhm · 1.699
      3. Gaussian back-out from ``area`` and ``height``:
         area = height · σ · √(2π)  ⇒  σ = area / (height · √(2π)),
         baseline = 4σ
    Returns None if none of these are derivable.
    """
    for key in ("width_baseline_min", "width_min"):
        v = peak.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    fwhm = peak.get("fwhm_min")
    if isinstance(fwhm, (int, float)) and fwhm > 0:
        return float(fwhm) * (4.0 / 2.3548)
    area = peak.get("area")
    height = peak.get("height")
    if (
        isinstance(area, (int, float)) and area > 0
        and isinstance(height, (int, float)) and height > 0
    ):
        sigma = area / (height * math.sqrt(2.0 * math.pi))
        return 4.0 * sigma
    return None


def _resolution(p1: dict[str, Any], p2: dict[str, Any]) -> float | None:
    """USS resolution between two peaks: 2·Δt_R / (w1 + w2), widths at base.

    Returns None if either width cannot be estimated.
    """
    rt1 = p1.get("rt_min")
    rt2 = p2.get("rt_min")
    if not isinstance(rt1, (int, float)) or not isinstance(rt2, (int, float)):
        return None
    w1 = _peak_width_baseline_min(p1)
    w2 = _peak_width_baseline_min(p2)
    if w1 is None or w2 is None or (w1 + w2) <= 0:
        return None
    return 2.0 * abs(float(rt2) - float(rt1)) / (w1 + w2)


def _clean_sorted_peaks(
    peaks: Sequence[dict[str, Any]],
    min_area_fraction: float,
) -> list[dict[str, Any]]:
    """Drop peaks without a usable rt_min, drop sub-threshold (noise) peaks,
    sort by retention time."""
    usable = [p for p in peaks if isinstance(p.get("rt_min"), (int, float))]
    areas = [
        float(p["area"]) for p in usable
        if isinstance(p.get("area"), (int, float)) and float(p["area"]) > 0
    ]
    if areas:
        cutoff = max(areas) * min_area_fraction
        usable = [
            p for p in usable
            if not isinstance(p.get("area"), (int, float))
            or float(p["area"]) >= cutoff
        ]
    return sorted(usable, key=lambda p: float(p["rt_min"]))


def score_chromatogram(
    peaks: Sequence[dict[str, Any]],
    *,
    rs_target: float = DEFAULT_RS_TARGET,
    runtime_target_min: float = DEFAULT_RUNTIME_TARGET_MIN,
    runtime_min: float | None = None,
    b_solvent: str | None = None,
    b_meoh_fraction: float | None = None,
    flow_mLmin: float | None = None,
    avg_pctB: float | None = None,
    lambda_max: float = DEFAULT_LAMBDA_MAX,
    lambda_exponent: float = DEFAULT_LAMBDA_EXPONENT,
    peak_bonus: float = DEFAULT_PEAK_BONUS,
    min_area_fraction: float = DEFAULT_MIN_AREA_FRACTION,
) -> dict[str, Any]:
    """Compute the CRF + auxiliary MO objectives for one chromatogram.

    Returns a dict with: crf_total, min_resolution, n_resolved_pairs,
    n_peaks, runtime_min, solvent_pmi_g, resolutions (per-pair list),
    and resolution_target_met (bool). Designed so the caller can feed
    ``{"crf_total": ...}`` to a single-objective campaign or
    ``{"min_resolution": ..., "runtime_min": ..., "solvent_pmi_g": ...}``
    to a Pareto one.
    """
    clean = _clean_sorted_peaks(peaks, min_area_fraction)
    n_peaks = len(clean)

    resolutions: list[float] = []
    for a, b in pairwise(clean):
        rs = _resolution(a, b)
        if rs is not None:
            resolutions.append(rs)

    if resolutions:
        rs_min = min(resolutions)
        resolution_term = sum(min(rs / rs_target, 1.0) for rs in resolutions)
    else:
        # No measurable resolution — either a single peak (degenerate) or
        # peak shapes unavailable. min_resolution = 0 so MO ranks it last;
        # CRF gets no resolution term.
        rs_min = 0.0
        resolution_term = 0.0

    # Self-adapting time-penalty weight.
    f = min(rs_min / rs_target, 1.0) if rs_target > 0 else 0.0
    lam = lambda_max * (f ** lambda_exponent)

    # Runtime: explicit if given, else last-peak retention time as a floor.
    t_last = float(clean[-1]["rt_min"]) if clean else 0.0
    rt_total = float(runtime_min) if runtime_min is not None else t_last
    time_term = (
        (runtime_target_min - rt_total) / runtime_target_min
        if runtime_target_min > 0 else 0.0
    )

    crf_total = resolution_term + lam * time_term + peak_bonus * n_peaks

    # Solvent PMI (grams of organic per injection, ×(1+reequil)).
    # In ternary mode the B-channel density is a linear-weighted mix
    # (MeCN/MeOH) — see _resolve_b_solvent_density.
    solvent_pmi_g = 0.0
    if (
        flow_mLmin is not None and rt_total > 0
        and (b_solvent is not None or b_meoh_fraction is not None)
    ):
        rho = _resolve_b_solvent_density(b_solvent, b_meoh_fraction)
        frac_b = (avg_pctB / 100.0) if avg_pctB is not None else 0.5
        solvent_pmi_g = (
            float(flow_mLmin) * rt_total * rho * frac_b * (1.0 + _REEQUIL_FACTOR)
        )

    return {
        "crf_total": round(crf_total, 6),
        "min_resolution": round(rs_min, 4),
        "n_resolved_pairs": sum(1 for rs in resolutions if rs >= rs_target),
        "n_peaks": n_peaks,
        "runtime_min": round(rt_total, 4),
        "solvent_pmi_g": round(solvent_pmi_g, 4),
        "resolutions": [round(rs, 4) for rs in resolutions],
        "resolution_target_met": bool(resolutions) and rs_min >= rs_target,
    }
