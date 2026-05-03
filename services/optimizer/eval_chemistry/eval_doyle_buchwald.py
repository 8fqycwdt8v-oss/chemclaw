"""Doyle Buchwald-Hartwig HTE held-out evaluation (Z7 task).

Replays the open Doyle dataset (Science 2018) through the deployed
mcp-yield-baseline /predict_yield against the global pretrained model.
Reports RMSE + ECE for the ensemble vs chemprop-only vs xgboost-only.
Target: ECE < 0.10.

Inputs (env or kwargs):
  DOYLE_DATASET_PATH        — CSV with columns rxn_smiles,yield_pct
  MCP_YIELD_BASELINE_URL    — defaults to http://localhost:8015

Result shape: {task, status, metrics, passed, target}.
"""
from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any

import httpx
import numpy as np

_DEFAULT_BASE = "http://localhost:8015"


def _ece(predictions: list[dict[str, Any]], n_bins: int = 10) -> float:
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


def run(
    dataset_path: str | None = None,
    mcp_yield_baseline_url: str | None = None,
    target_ece: float = 0.10,
) -> dict[str, Any]:
    csv_path = dataset_path or os.environ.get("DOYLE_DATASET_PATH")
    if not csv_path or not Path(csv_path).exists():
        return {
            "task": "doyle_buchwald",
            "status": "skipped",
            "passed": False,
            "reason": "DOYLE_DATASET_PATH not set or file missing",
            "target": {"ece": target_ece},
        }
    base = (mcp_yield_baseline_url or os.environ.get("MCP_YIELD_BASELINE_URL", _DEFAULT_BASE)).rstrip("/")

    rows: list[tuple[str, float]] = []
    with open(csv_path) as f:
        next(f)
        for line in f:
            parts = line.strip().split(",")
            if len(parts) < 2:
                continue
            try:
                rows.append((parts[0], float(parts[1])))
            except ValueError:
                continue

    predictions: list[dict[str, Any]] = []
    with httpx.Client(timeout=300.0) as cli:
        for batch_start in range(0, len(rows), 100):
            batch = rows[batch_start : batch_start + 100]
            resp = cli.post(
                f"{base}/predict_yield",
                json={
                    "rxn_smiles_list": [r[0] for r in batch],
                    "used_global_fallback": True,
                },
            )
            if resp.status_code != 200:
                return {
                    "task": "doyle_buchwald",
                    "status": "error",
                    "passed": False,
                    "error": f"mcp-yield-baseline returned {resp.status_code}: {resp.text[:200]}",
                }
            for (_, y_true), pred in zip(batch, resp.json()["predictions"]):
                predictions.append({
                    "true": y_true,
                    "ensemble_mean": pred["ensemble_mean"],
                    "ensemble_std": pred["ensemble_std"],
                    "chemprop_mean": pred["components"]["chemprop_mean"],
                    "xgboost_mean": pred["components"]["xgboost_mean"],
                })

    rmse = math.sqrt(float(np.mean([(p["true"] - p["ensemble_mean"]) ** 2 for p in predictions])))
    rmse_chem = math.sqrt(
        float(np.mean([(p["true"] - p["chemprop_mean"]) ** 2 for p in predictions]))
    )
    rmse_xgb = math.sqrt(
        float(np.mean([(p["true"] - p["xgboost_mean"]) ** 2 for p in predictions]))
    )
    ece = _ece(predictions)

    return {
        "task": "doyle_buchwald",
        "status": "ok",
        "metrics": {
            "n": len(predictions),
            "rmse_ensemble": rmse,
            "rmse_chemprop_only": rmse_chem,
            "rmse_xgboost_only": rmse_xgb,
            "ece_ensemble": ece,
        },
        "target": {"ece": target_ece},
        "passed": ece < target_ece,
    }
