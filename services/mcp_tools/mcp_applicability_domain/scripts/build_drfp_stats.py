"""Build a DRFP stats artifact from a Postgres reactions corpus.

Run inside the chemclaw .venv:
    .venv/bin/python services/mcp_tools/mcp_applicability_domain/scripts/build_drfp_stats.py

Reads `reactions.drfp_vector` cross-project as chemclaw_service (BYPASSRLS) and
emits aggregate mean + diagonal covariance + chi-square thresholds. This is
aggregate-only data; no per-row leakage.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np


def main() -> None:
    dsn = os.environ.get("CHEMCLAW_SERVICE_DSN")
    if not dsn:
        print("Set CHEMCLAW_SERVICE_DSN (chemclaw_service role) to build from real data.")
        print("Falling back to synthetic stats for dev.")
        _write_synthetic()
        return

    try:
        import psycopg
    except ImportError:
        print("psycopg not installed; install with `.venv/bin/pip install psycopg`", file=sys.stderr)
        sys.exit(1)

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SET search_path TO public")
            cur.execute(
                "SELECT drfp_vector::text FROM reactions WHERE drfp_vector IS NOT NULL"
            )
            rows = cur.fetchall()

    if not rows:
        print("No drfp_vector rows; emitting synthetic stats.")
        _write_synthetic()
        return

    vectors = []
    for (text,) in rows:
        bits = json.loads(text)
        vectors.append(bits)
    arr = np.asarray(vectors, dtype=np.float64)

    mean = arr.mean(axis=0)
    var = arr.var(axis=0) + 1e-6
    n_train = arr.shape[0]
    threshold_in = 2150.0
    threshold_out = 2200.0

    out = {
        "mean": mean.tolist(),
        "var_diag": var.tolist(),
        "n_train": int(n_train),
        "snapshot_at": "2026-04-30T00:00:00Z",
        "threshold_in": threshold_in,
        "threshold_out": threshold_out,
        "version": "drfp_stats_v1",
    }
    target = Path(__file__).resolve().parents[1] / "data" / "drfp_stats_v1.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out))
    print(f"Wrote {target} (n_train={n_train})")


def _write_synthetic() -> None:
    """Fallback synthetic stats so tests can run without a live DB."""
    mean = [0.05] * 2048
    var = [0.05 * 0.95] * 2048
    out = {
        "mean": mean,
        "var_diag": var,
        "n_train": 1,
        "snapshot_at": "2026-04-30T00:00:00Z",
        "threshold_in": 2150.0,
        "threshold_out": 2200.0,
        "version": "drfp_stats_v1_synthetic",
    }
    target = Path(__file__).resolve().parents[1] / "data" / "drfp_stats_v1.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out))
    print(f"Wrote synthetic {target}")


if __name__ == "__main__":
    main()
