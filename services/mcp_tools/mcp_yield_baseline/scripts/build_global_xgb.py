"""Build the global pretrained XGBoost artifact.

Reads (rxn_smiles, yield_pct) pairs from reactions JOIN experiments as
chemclaw_service (BYPASSRLS, aggregate-only — no per-row leakage), DRFP-
encodes each pair, fits XGBRegressor, saves data/xgb_global_v1.json plus
metadata.

Synthetic fallback for dev environments without a populated reactions table.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from services.mcp_tools.common.logging import configure_logging

configure_logging(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_TARGET = Path(__file__).resolve().parents[1] / "data" / "xgb_global_v1.json"
_META = Path(__file__).resolve().parents[1] / "data" / "xgb_global_v1.meta.json"


def _write(model: object, n_train: int, dataset: str, holdout_rmse: float) -> None:
    import xgboost as xgb  # noqa: PLC0415

    _TARGET.parent.mkdir(parents=True, exist_ok=True)
    booster = model.get_booster() if hasattr(model, "get_booster") else model
    booster.save_model(str(_TARGET))
    _META.write_text(
        json.dumps(
            {
                "n_train": n_train,
                "dataset": dataset,
                "snapshot_at": datetime.now(tz=timezone.utc).isoformat(),
                "xgboost_version": xgb.__version__,
                "holdout_rmse": holdout_rmse,
                "version": "xgb_global_v1",
            }
        )
    )
    log.info(
        "wrote global xgb artifact",
        extra={"target": str(_TARGET), "n_train": n_train, "holdout_rmse": holdout_rmse},
    )


def _write_synthetic() -> None:
    import xgboost as xgb  # noqa: PLC0415

    rng = np.random.default_rng(seed=42)
    X = rng.integers(0, 2, size=(200, 2048)).astype(np.float64)
    y = rng.uniform(20, 90, 200)
    model = xgb.XGBRegressor(
        n_estimators=50, max_depth=4, learning_rate=0.05, verbosity=0
    )
    model.fit(X, y)
    _write(model, n_train=200, dataset="synthetic_dev", holdout_rmse=float("nan"))


def main() -> None:
    dsn = os.environ.get("CHEMCLAW_SERVICE_DSN")
    if not dsn:
        log.info("CHEMCLAW_SERVICE_DSN unset; emitting synthetic global model")
        _write_synthetic()
        return

    try:
        import psycopg
        import xgboost as xgb  # noqa: F401, PLC0415
    except ImportError as exc:
        log.error("missing deps", extra={"err": type(exc).__name__})
        sys.exit(1)

    import httpx

    drfp_url = os.environ.get("MCP_DRFP_URL", "http://localhost:8002").rstrip("/")

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SET search_path TO public")
            # ORDER BY r.id is required for determinism: without it, the
            # implementation-defined row order changes as the table grows
            # and the same `seed=42` reproduces a different artifact.
            cur.execute(
                """
                SELECT r.rxn_smiles, e.yield_pct::float
                  FROM reactions r
                  JOIN experiments e ON e.id = r.experiment_id
                 WHERE r.rxn_smiles IS NOT NULL AND e.yield_pct IS NOT NULL
                 ORDER BY r.id
                 LIMIT 100000
                """
            )
            rows = cur.fetchall()

    if len(rows) < 50:
        log.warning("insufficient rows; emitting synthetic", extra={"n_rows": len(rows)})
        _write_synthetic()
        return

    smiles = [r[0] for r in rows]
    y = np.asarray([r[1] for r in rows], dtype=np.float64)

    log.info("encoding reactions via DRFP", extra={"n": len(smiles)})
    with httpx.Client(timeout=300.0) as cli:
        resp = cli.post(
            f"{drfp_url}/tools/compute_drfp",
            json={
                "rxn_smiles_list": smiles,
                "n_folded_length": 2048,
                "radius": 3,
            },
        )
        resp.raise_for_status()
        body = resp.json()
        X = np.asarray([v["vector"] for v in body["vectors"]], dtype=np.float64)

    rng = np.random.default_rng(seed=42)
    perm = rng.permutation(len(y))
    n_holdout = max(1, len(y) // 10)
    val_idx, tr_idx = perm[:n_holdout], perm[n_holdout:]

    import xgboost as xgb  # noqa: PLC0415

    model = xgb.XGBRegressor(
        n_estimators=500,
        max_depth=6,
        learning_rate=0.05,
        early_stopping_rounds=10,
        verbosity=0,
    )
    model.fit(
        X[tr_idx], y[tr_idx], eval_set=[(X[val_idx], y[val_idx])], verbose=False
    )
    preds = model.predict(X[val_idx])
    rmse = float(np.sqrt(np.mean((preds - y[val_idx]) ** 2)))
    _write(model, n_train=len(tr_idx), dataset="reactions+experiments", holdout_rmse=rmse)


if __name__ == "__main__":
    main()
