"""FastAPI app for mcp-tabicl — featurize + predict_and_rank + pca_refit."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app

from .featurizer import ReactionRow, featurize
from .inference import predict_and_rank
from .pca import FittedPca, PCA_N_COMPONENTS, PCA_N_FEATURES, fit_and_save, load

log = logging.getLogger("mcp-tabicl")

DEFAULT_PCA_PATH = Path(os.getenv("MCP_TABICL_PCA_PATH", "/var/cache/mcp-tabicl/drfp_pca.json"))
ADMIN_TOKEN_ENV = "MCP_TABICL_ADMIN_TOKEN"


class ReactionRowIn(BaseModel):
    reaction_id: str = Field(min_length=1, max_length=64)
    rxn_smiles: str = Field(min_length=3, max_length=20_000)
    rxno_class: str | None = Field(default=None, max_length=200)
    solvent: str | None = Field(default=None, max_length=200)
    temp_c: float | None = None
    time_min: float | None = None
    catalyst_loading_mol_pct: float | None = None
    base: str | None = Field(default=None, max_length=200)
    yield_pct: float | None = None


class FeaturizeIn(BaseModel):
    reaction_rows: list[ReactionRowIn] = Field(max_length=1001)  # enforce cap in code
    include_targets: bool = True


class FeaturizeOut(BaseModel):
    feature_names: list[str]
    categorical_names: list[str]
    rows: list[list[Any]]
    targets: list[float] | None
    skipped: list[dict[str, Any]]


class PredictIn(BaseModel):
    support_rows: list[list[Any]] = Field(min_length=1, max_length=1000)
    support_targets: list[float] = Field(min_length=1, max_length=1000)
    query_rows: list[list[Any]] = Field(min_length=1, max_length=1000)
    feature_names: list[str] = Field(min_length=1, max_length=512)
    categorical_names: list[str] = Field(default_factory=list, max_length=512)
    task: str = Field(pattern="^(regression|classification)$")
    return_feature_importance: bool = False


class PredictOut(BaseModel):
    predictions: list[float]
    prediction_std: list[float]
    feature_importance: dict[str, float] | None


class PcaRefitIn(BaseModel):
    drfp_matrix: list[list[int]] = Field(min_length=PCA_N_COMPONENTS, max_length=100_000)


def _ready_check(pca_path: Path) -> bool:
    return pca_path.exists()


def build_app(*, pca_path: Path = DEFAULT_PCA_PATH) -> FastAPI:
    app = create_app(
        name="mcp-tabicl",
        version="0.1.0",
        ready_check=lambda: _ready_check(pca_path),
    )

    def _require_pca() -> FittedPca:
        if not pca_path.exists():
            raise HTTPException(status_code=503, detail="PCA artifact missing")
        return load(pca_path)

    @app.post("/featurize", response_model=FeaturizeOut)
    def _featurize(payload: FeaturizeIn) -> FeaturizeOut:
        fitted = _require_pca()
        rows = [
            ReactionRow(
                reaction_id=r.reaction_id,
                rxn_smiles=r.rxn_smiles,
                rxno_class=r.rxno_class,
                solvent=r.solvent,
                temp_c=r.temp_c,
                time_min=r.time_min,
                catalyst_loading_mol_pct=r.catalyst_loading_mol_pct,
                base=r.base,
                yield_pct=r.yield_pct,
            )
            for r in payload.reaction_rows
        ]
        schema, X, y, skipped = featurize(rows, fitted, include_targets=payload.include_targets)
        # Convert object matrix → JSON-serialisable.
        serialised_rows: list[list[Any]] = []
        for i in range(X.shape[0]):
            row_vals: list[Any] = []
            for j in range(X.shape[1]):
                v = X[i, j]
                if isinstance(v, (np.floating, np.integer)):
                    row_vals.append(float(v))
                elif isinstance(v, float):
                    row_vals.append(v if np.isfinite(v) else None)
                else:
                    row_vals.append(v)
            serialised_rows.append(row_vals)
        return FeaturizeOut(
            feature_names=schema.feature_names,
            categorical_names=sorted(schema.categorical_names),
            rows=serialised_rows,
            targets=(y.tolist() if y is not None else None),
            skipped=skipped,
        )

    @app.post("/predict_and_rank", response_model=PredictOut)
    def _predict(payload: PredictIn) -> PredictOut:
        support = np.asarray(payload.support_rows, dtype="object")
        query = np.asarray(payload.query_rows, dtype="object")
        targets = np.asarray(payload.support_targets, dtype="float64")
        result = predict_and_rank(
            support_rows=support,
            support_targets=targets,
            query_rows=query,
            feature_names=payload.feature_names,
            categorical_names=frozenset(payload.categorical_names),
            task=payload.task,
            return_feature_importance=payload.return_feature_importance,
        )
        return PredictOut(
            predictions=result.predictions.astype("float64").tolist(),
            prediction_std=result.prediction_std.astype("float64").tolist(),
            feature_importance=result.feature_importance,
        )

    @app.post("/pca_refit")
    def _pca_refit(
        payload: PcaRefitIn,
        x_admin_token: str | None = Header(default=None, alias="x-admin-token"),
    ) -> dict[str, Any]:
        expected = os.getenv(ADMIN_TOKEN_ENV)
        if not expected or x_admin_token != expected:
            raise HTTPException(status_code=403, detail="admin token required")
        X = np.asarray(payload.drfp_matrix, dtype="float64")
        fit_and_save(X, pca_path)
        return {"status": "ok", "n_rows": int(X.shape[0]), "path": str(pca_path)}

    return app


# Uvicorn entrypoint
app = build_app()
