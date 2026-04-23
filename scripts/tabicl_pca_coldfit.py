"""Cold-fit the mcp-tabicl DRFP PCA over all reactions in the database.

Run from the host:
    .venv/bin/python scripts/tabicl_pca_coldfit.py \
        --out /var/cache/mcp-tabicl/drfp_pca.json

Requires existing DRFP-vectorised reactions. This is an explicit
admin action — never invoked lazily inside a request path.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
import psycopg

from services.mcp_tools.mcp_tabicl.pca import PCA_N_FEATURES, fit_and_save


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    dsn = (
        f"host={os.environ.get('POSTGRES_HOST', 'localhost')} "
        f"port={os.environ.get('POSTGRES_PORT', '5432')} "
        f"dbname={os.environ.get('POSTGRES_DB', 'chemclaw')} "
        f"user={os.environ.get('POSTGRES_USER', 'chemclaw')} "
        f"password={os.environ.get('POSTGRES_PASSWORD', '')}"
    )
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT drfp_vector FROM reactions WHERE drfp_vector IS NOT NULL")
        rows = cur.fetchall()
    if not rows:
        raise SystemExit("no DRFP vectors found; run the reaction-vectorizer first")

    # Each drfp_vector is a pgvector literal '[0,1,0,...]' — psycopg returns it
    # as a list already when pgvector adapter is registered; fall back to parse.
    matrix: list[list[float]] = []
    for (v,) in rows:
        if isinstance(v, (list, tuple)):
            matrix.append([float(b) for b in v])
        elif isinstance(v, str):
            matrix.append([float(b) for b in v.strip("[]").split(",") if b])
        else:
            raise RuntimeError(f"unexpected drfp_vector type: {type(v)!r}")
    X = np.asarray(matrix, dtype="float64")
    if X.shape[1] != PCA_N_FEATURES:
        raise SystemExit(f"expected {PCA_N_FEATURES} features; got {X.shape[1]}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    fit_and_save(X, args.out)
    print(f"wrote PCA artifact ({X.shape[0]} rows) to {args.out}")


if __name__ == "__main__":
    main()
