"""Calibration / regression metrics shared between the deploy script and
the chemistry-eval suite.

Single source of truth: a fix here propagates to /eval and the
post-deploy ECE check at once.
"""
from __future__ import annotations

from typing import Iterable, TypedDict

import numpy as np


class CalibrationPoint(TypedDict):
    true: float
    ensemble_mean: float
    ensemble_std: float


def expected_calibration_error(
    predictions: Iterable[CalibrationPoint], n_bins: int = 10
) -> float:
    """Expected Calibration Error against absolute error.

    Bins predictions by `ensemble_std`; in each bin compares the mean abs
    error to the mean predicted std. Returns NaN on empty input.
    """
    items = list(predictions)
    if not items:
        return float("nan")
    errors = [abs(p["true"] - p["ensemble_mean"]) for p in items]
    stds = [p["ensemble_std"] for p in items]
    bins = np.linspace(0, max(stds) + 1e-6, n_bins + 1)
    n = len(errors)
    ece = 0.0
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        in_bin = [j for j, s in enumerate(stds) if lo <= s < hi]
        if not in_bin:
            continue
        avg_err = float(np.mean([errors[j] for j in in_bin]))
        avg_std = float(np.mean([stds[j] for j in in_bin]))
        ece += (len(in_bin) / n) * abs(avg_err - avg_std)
    return float(ece)
