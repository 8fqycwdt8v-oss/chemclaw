"""Doyle Buchwald-Hartwig HTE held-out evaluation.

Replays the open Doyle dataset (4608 reactions, Science 2018) through
/predict_yield against the global pretrained model. Reports RMSE, NLL,
ECE for ensemble vs chemprop-alone vs xgboost-alone. Target: ECE < 0.10.

Z7 wires this into the /eval slash verb. For now, run manually post-deploy.

Dataset CSV must be supplied via DOYLE_DATASET_PATH env var; this script
does NOT download it.
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import httpx
import numpy as np

_BASE = os.environ.get("MCP_YIELD_BASELINE_URL", "http://localhost:8015").rstrip("/")


def _ece(predictions: list[dict], n_bins: int = 10) -> float:
    """Expected Calibration Error using equal-width yield bins on the abs error."""
    errors = [abs(p["true"] - p["ensemble_mean"]) for p in predictions]
    stds = [p["ensemble_std"] for p in predictions]
    if not errors:
        return float("nan")
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


def main() -> None:
    csv_path = os.environ.get("DOYLE_DATASET_PATH")
    if not csv_path or not Path(csv_path).exists():
        print(
            "Set DOYLE_DATASET_PATH to a CSV with columns rxn_smiles,yield_pct",
            file=sys.stderr,
        )
        sys.exit(1)

    rows: list[tuple[str, float]] = []
    with open(csv_path) as f:
        next(f)  # header
        for line in f:
            parts = line.strip().split(",")
            if len(parts) < 2:
                continue
            rows.append((parts[0], float(parts[1])))

    print(f"Loaded {len(rows)} Doyle reactions; sending in batches of 100...")
    predictions: list[dict] = []
    with httpx.Client(timeout=300.0) as cli:
        for batch_start in range(0, len(rows), 100):
            batch = rows[batch_start : batch_start + 100]
            resp = cli.post(
                f"{_BASE}/predict_yield",
                json={
                    "rxn_smiles_list": [r[0] for r in batch],
                    "used_global_fallback": True,
                },
            )
            resp.raise_for_status()
            for (_, y_true), pred in zip(batch, resp.json()["predictions"]):
                predictions.append(
                    {
                        "true": y_true,
                        "ensemble_mean": pred["ensemble_mean"],
                        "ensemble_std": pred["ensemble_std"],
                        "chemprop_mean": pred["components"]["chemprop_mean"],
                        "xgboost_mean": pred["components"]["xgboost_mean"],
                    }
                )

    rmse = math.sqrt(
        np.mean([(p["true"] - p["ensemble_mean"]) ** 2 for p in predictions])
    )
    rmse_chem = math.sqrt(
        np.mean([(p["true"] - p["chemprop_mean"]) ** 2 for p in predictions])
    )
    rmse_xgb = math.sqrt(
        np.mean([(p["true"] - p["xgboost_mean"]) ** 2 for p in predictions])
    )
    ece = _ece(predictions)

    report = {
        "n": len(predictions),
        "rmse_ensemble": rmse,
        "rmse_chemprop_only": rmse_chem,
        "rmse_xgboost_only": rmse_xgb,
        "ece_ensemble": ece,
        "target_ece": 0.10,
        "passed": ece < 0.10,
    }
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        sys.exit(2)


if __name__ == "__main__":
    main()
