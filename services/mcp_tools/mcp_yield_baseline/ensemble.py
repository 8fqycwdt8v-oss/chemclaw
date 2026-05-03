"""Pure-function ensemble math for mcp-yield-baseline.

Combines a chemprop MVE-head prediction (mean, std) with a single XGBoost
mean. Returns ensemble_mean (average) and ensemble_std (sqrt of chemprop_std²
plus disagreement²/4). Both component scores travel into the response so the
ensemble is auditable.

Yield-percentage clipping: ensemble_mean is clamped to [0, 100] so the
response is always a sensible yield value even if the upstream models
predict out-of-range.
"""
from __future__ import annotations

import math
from typing import Any


def combine_ensemble(
    chemprop_mean: float,
    chemprop_std: float,
    xgboost_mean: float,
) -> dict[str, Any]:
    """Return {ensemble_mean, ensemble_std, components} for a single reaction."""
    if chemprop_std < 0:
        raise ValueError(f"chemprop_std must be non-negative; got {chemprop_std}")

    ensemble_mean = (chemprop_mean + xgboost_mean) / 2.0
    ensemble_mean = max(0.0, min(100.0, ensemble_mean))

    half_diff = (chemprop_mean - xgboost_mean) / 2.0
    ensemble_std = math.sqrt(chemprop_std * chemprop_std + half_diff * half_diff)

    return {
        "ensemble_mean": ensemble_mean,
        "ensemble_std": ensemble_std,
        "components": {
            "chemprop_mean": chemprop_mean,
            "chemprop_std": chemprop_std,
            "xgboost_mean": xgboost_mean,
        },
    }


def combine_batch(
    chemprop_means: list[float],
    chemprop_stds: list[float],
    xgboost_means: list[float],
) -> list[dict[str, Any]]:
    """Vectorized combine over equal-length lists."""
    if not (len(chemprop_means) == len(chemprop_stds) == len(xgboost_means)):
        raise ValueError(
            f"length mismatch: chemprop_means={len(chemprop_means)}, "
            f"chemprop_stds={len(chemprop_stds)}, xgboost_means={len(xgboost_means)}"
        )
    return [
        combine_ensemble(cm, cs, xm)
        for cm, cs, xm in zip(chemprop_means, chemprop_stds, xgboost_means)
    ]
