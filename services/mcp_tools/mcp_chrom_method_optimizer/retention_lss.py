"""Linear-solvent-strength (LSS) retention modelling — cheap fidelity for
warm-starting the chromatography BO loop.

Snyder–Dolan LSS: for a reversed-phase analyte the isocratic retention
factor obeys

    log10 k(φ) = log10 k_w − S · φ                       (φ = volume fraction organic)

so two or more isocratic injections at different φ give (log10 k_w, S) by
linear regression. Once fitted, the elution time under *any* gradient
program g(t) → φ(t) follows from the gradient-migration integral

    ∫₀^{t_R}  dt' / ( t₀ · k(φ(t' − t_dwell)) )  =  1

which we solve numerically by marching the gradient in small steps and
accumulating the fractional migration until it reaches 1. (For a single
linear ramp this reduces to the well-known Snyder closed form; the
numerical march handles hold–ramp–hold and multi-segment programs too.)

This module is pure math — no BoFire, no I/O. The BO loop uses it to:
  1. fit per-analyte LSS from a handful of scouting injections, then
  2. simulate t_R (hence resolution / runtime) for thousands of candidate
     gradients in milliseconds, and pick the most promising ones to run
     for real (a 2-stage / multi-fidelity warm start). The full
     cost-aware MFBO acquisition is a further extension; this gives most
     of the win via simulated-CRF top-k filtering of the cold-start batch.

Caveats: assumes the same column / B-solvent / additive / temperature as
the scouting runs (LSS coefficients are condition-specific). Peak width is
estimated from a constant plate count N (default 10 000) — good enough for
ranking candidates, not for absolute resolution prediction.
"""
from __future__ import annotations

import math
from itertools import pairwise
from typing import Any, Sequence

DEFAULT_PLATE_COUNT = 10_000
# Numerical-march step (minutes). Small relative to typical peak widths.
DEFAULT_MARCH_STEP_MIN = 0.005
# Cap the march so a non-eluting analyte (k stays huge) returns a sentinel
# instead of looping forever.
DEFAULT_MAX_MARCH_MIN = 240.0


def fit_lss_isocratic(
    observations: Sequence[tuple[float, float]],
    t0_min: float,
) -> tuple[float, float] | None:
    """Fit (log10_kw, S) from isocratic (φ, t_R) pairs.

    observations: list of (phi, t_R_min) with phi in [0, 1]. Needs ≥ 2
    distinct φ values; returns None if under-determined or any retention
    factor is non-positive (t_R ≤ t0 — unretained, can't fit).
    """
    pts: list[tuple[float, float]] = []
    for phi, tr in observations:
        k = (float(tr) - t0_min) / t0_min
        if k <= 0:
            continue
        pts.append((float(phi), math.log10(k)))
    if len({p for p, _ in pts}) < 2:
        return None
    n = len(pts)
    sx = sum(p for p, _ in pts)
    sy = sum(y for _, y in pts)
    sxx = sum(p * p for p, _ in pts)
    sxy = sum(p * y for p, y in pts)
    denom = n * sxx - sx * sx
    if abs(denom) < 1e-12:
        return None
    slope = (n * sxy - sx * sy) / denom          # = −S
    intercept = (sy - slope * sx) / n            # = log10 k_w
    return intercept, -slope


def _phi_at(gradient_program: Sequence[dict[str, float]], t_min: float) -> float:
    """Linearly-interpolated organic fraction at column-inlet time t (minutes).

    gradient_program: ordered [{time_min, pctB}, …]. Clamped at both ends.
    Returns φ = pctB/100.
    """
    if not gradient_program:
        return 0.0
    first = gradient_program[0]
    last = gradient_program[-1]
    if t_min <= first["time_min"]:
        return first["pctB"] / 100.0
    if t_min >= last["time_min"]:
        return last["pctB"] / 100.0
    for a, b in pairwise(gradient_program):
        if a["time_min"] <= t_min <= b["time_min"]:
            span = b["time_min"] - a["time_min"]
            if span <= 0:
                return b["pctB"] / 100.0
            frac = (t_min - a["time_min"]) / span
            return (a["pctB"] + frac * (b["pctB"] - a["pctB"])) / 100.0
    return last["pctB"] / 100.0


def simulate_retention_gradient(
    log10_kw: float,
    S: float,
    gradient_program: Sequence[dict[str, float]],
    t0_min: float,
    *,
    t_dwell_min: float = 0.0,
    march_step_min: float = DEFAULT_MARCH_STEP_MIN,
    max_march_min: float = DEFAULT_MAX_MARCH_MIN,
) -> float | None:
    """Numerically integrate the gradient-migration equation → t_R (minutes).

    Returns None if the analyte does not elute within max_march_min.
    """
    if t0_min <= 0:
        return None
    t = 0.0
    migrated = 0.0
    while t < max_march_min:
        phi = _phi_at(gradient_program, t - t_dwell_min)
        log10_k = log10_kw - S * phi
        k = 10.0 ** log10_k
        # Fraction-of-column-traversed rate (per minute) = 1 / (t0 · (1 + k)),
        # so the isocratic limit reduces to t_R = t0·(1 + k). (For k ≫ 1 this
        # matches the classic Snyder gradient-LSS form that drops the +1.)
        rate = 1.0 / (t0_min * (1.0 + k))
        step = march_step_min
        migrated += rate * step
        t += step
        if migrated >= 1.0:
            # linear back-off within the last step for sub-step accuracy
            over = migrated - 1.0
            t -= (over / (rate if rate > 0 else 1.0))
            return t
    return None


def estimate_peak_width_min(
    t_R_min: float, t0_min: float, plate_count: int = DEFAULT_PLATE_COUNT,
) -> float:
    """Baseline (4σ) width for a peak at t_R given a plate count N.

    σ = t_R / √N ; baseline = 4σ. Gradient peaks are narrower than the
    isocratic estimate (band compression), so this is conservative — fine
    for *ranking* candidate gradients.
    """
    if plate_count <= 0 or t_R_min <= 0:
        return max(t_R_min * 0.01, 1e-3)
    sigma = t_R_min / math.sqrt(plate_count)
    return 4.0 * sigma


def simulate_chromatogram(
    lss_by_analyte: dict[str, tuple[float, float]],
    gradient_program: Sequence[dict[str, float]],
    t0_min: float,
    *,
    plate_count: int = DEFAULT_PLATE_COUNT,
    t_dwell_min: float = 0.0,
) -> list[dict[str, Any]]:
    """Simulate a peak list (name, rt_min, width_baseline_min) for each analyte.

    Analytes that don't elute within the march cap are dropped (and the
    caller can treat that as a failed separation). Output is sorted by rt.
    """
    peaks: list[dict[str, Any]] = []
    for name, (log10_kw, S) in lss_by_analyte.items():
        tr = simulate_retention_gradient(
            log10_kw, S, gradient_program, t0_min, t_dwell_min=t_dwell_min,
        )
        if tr is None:
            continue
        peaks.append({
            "name": name,
            "rt_min": round(tr, 5),
            "width_baseline_min": round(estimate_peak_width_min(tr, t0_min, plate_count), 6),
        })
    return sorted(peaks, key=lambda p: p["rt_min"])
