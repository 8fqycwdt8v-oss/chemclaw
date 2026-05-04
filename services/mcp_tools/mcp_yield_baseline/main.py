"""mcp-yield-baseline — per-project ensemble yield prediction (port 8015).

Tools:
- POST /train          — fit per-project XGBoost from (rxn_smiles, yield_pct) pairs
- POST /predict_yield  — chemprop + per-project XGBoost ensemble with calibrated UQ

Stateless: no DB. The agent-claw builtin owns the RLS-scoped training-data pull.
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, AsyncIterator

import anyio
import httpx
import numpy as np
from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_RXN_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings
from services.mcp_tools.mcp_yield_baseline import cache as _cache
from services.mcp_tools.mcp_yield_baseline.ensemble import combine_batch

log = logging.getLogger("mcp-yield-baseline")
settings = ToolSettings()

_GLOBAL_XGB_PATH = Path(os.environ.get(
    "MCP_YIELD_BASELINE_GLOBAL_XGB_PATH",
    str(Path(__file__).parent / "data" / "xgb_global_v1.json"),
))

_GLOBAL_XGB_MODEL: Any | None = None  # xgboost.Booster — loaded at startup


def _load_global_xgb() -> Any | None:
    if not _GLOBAL_XGB_PATH.exists():
        return None
    try:
        import xgboost as xgb  # noqa: PLC0415
    except ImportError:
        log.warning("xgboost not installed; global model unavailable")
        return None
    booster = xgb.Booster()
    booster.load_model(str(_GLOBAL_XGB_PATH))
    return booster


def _is_ready() -> bool:
    return _GLOBAL_XGB_MODEL is not None


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Load global XGBoost artifact at startup."""
    global _GLOBAL_XGB_MODEL
    _GLOBAL_XGB_MODEL = _load_global_xgb()
    yield


app = create_app(
    name="mcp-yield-baseline",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_yield_baseline:invoke",
    lifespan=_lifespan,
)


# ---------------------------------------------------------------------------
# /train — per-project XGBoost fitting
# ---------------------------------------------------------------------------

# Min pairs to fit a per-project model. < 50 → builtin should pass
# used_global_fallback=true and skip /train entirely.
_MIN_TRAIN_PAIRS = 50


class TrainingPair(BaseModel):
    rxn_smiles: str = Field(min_length=3, max_length=MAX_RXN_SMILES_LEN)
    yield_pct: float = Field(ge=-1.0, le=110.0)


class TrainIn(BaseModel):
    project_internal_id: str = Field(min_length=1, max_length=200)
    training_pairs: list[TrainingPair] = Field(
        min_length=_MIN_TRAIN_PAIRS, max_length=10_000
    )


class TrainOut(BaseModel):
    model_id: str
    n_train: int
    cached_for_seconds: int


def _drfp_url() -> str:
    return os.environ.get("MCP_DRFP_URL", "http://localhost:8002").rstrip("/")


def _chemprop_url() -> str:
    return os.environ.get("MCP_CHEMPROP_URL", "http://localhost:8009").rstrip("/")


def _encode_drfp_batch(rxn_smiles_list: list[str]) -> list[list[float]]:
    """Call mcp-drfp /tools/compute_drfp for a batch.

    Stubbed in tests via mock.patch on this exact symbol.

    The Bearer token is minted via the shared McpTokenCache so production
    deploys with MCP_AUTH_REQUIRED=true accept the request. In dev mode
    (no MCP_AUTH_SIGNING_KEY) the helper returns an empty header dict and
    the receiving service accepts the unsigned request when its own
    MCP_AUTH_DEV_MODE is true. See services/mcp_tools/common/mcp_token_cache.py.
    """
    from services.mcp_tools.common.mcp_token_cache import auth_headers

    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            f"{_drfp_url()}/tools/compute_drfp",
            json={
                "rxn_smiles_list": rxn_smiles_list,
                "n_folded_length": 2048,
                "radius": 3,
            },
            headers=auth_headers("mcp-drfp"),
        )
        resp.raise_for_status()
        body = resp.json()
        return [v["vector"] for v in body["vectors"]]


def _call_chemprop_batch(rxn_smiles_list: list[str]) -> list[tuple[float, float]]:
    """Call mcp-chemprop /predict_yield. Stubbed in tests.

    See _encode_drfp_batch for the McpTokenCache rationale.
    """
    from services.mcp_tools.common.mcp_token_cache import auth_headers

    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            f"{_chemprop_url()}/predict_yield",
            json={"rxn_smiles_list": rxn_smiles_list},
            headers=auth_headers("mcp-chemprop"),
        )
        resp.raise_for_status()
        body = resp.json()
        return [(p["mean"], p["std"]) for p in body["predictions"]]


@app.post("/train", response_model=TrainOut, tags=["yield_baseline"])
async def train(req: Annotated[TrainIn, Body(...)]) -> TrainOut:
    pairs_dicts = [p.model_dump() for p in req.training_pairs]
    model_id = _cache.deterministic_id(req.project_internal_id, pairs_dicts)

    cached = _cache.get(model_id)
    if cached is not None:
        return TrainOut(
            model_id=model_id, n_train=len(pairs_dicts), cached_for_seconds=30 * 60
        )

    smiles = [p.rxn_smiles for p in req.training_pairs]
    yields = [p.yield_pct for p in req.training_pairs]
    if float(np.var(yields)) < 1e-6:
        raise HTTPException(
            status_code=422,
            detail="training_failed: degenerate yield variance (all labels equal)",
        )

    try:
        # _encode_drfp_batch uses sync httpx.Client (mocked in tests on this
        # exact symbol). Run on a worker thread so the route stays non-blocking.
        vectors = await anyio.to_thread.run_sync(_encode_drfp_batch, smiles)
    except httpx.HTTPError as exc:
        # Don't echo `exc` into `detail`: httpx errors stringify request URL +
        # response body, both of which can carry SMILES from the upstream call.
        log.warning("drfp upstream call failed", extra={"err": type(exc).__name__})
        raise HTTPException(status_code=503, detail="drfp_unavailable") from exc

    X = np.asarray(vectors, dtype=np.float64)
    y = np.asarray(yields, dtype=np.float64)

    try:
        import xgboost as xgb  # noqa: PLC0415
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="xgboost not available") from exc

    model = xgb.XGBRegressor(
        n_estimators=500,
        max_depth=6,
        learning_rate=0.05,
        early_stopping_rounds=10,
        verbosity=0,
    )
    n_holdout = max(1, len(y) // 10)
    rng = np.random.default_rng(seed=42)
    perm = rng.permutation(len(y))
    val_idx = perm[:n_holdout]
    tr_idx = perm[n_holdout:]
    model.fit(
        X[tr_idx], y[tr_idx], eval_set=[(X[val_idx], y[val_idx])], verbose=False
    )

    _cache.store(model_id, model)
    return TrainOut(
        model_id=model_id, n_train=len(pairs_dicts), cached_for_seconds=30 * 60
    )


# ---------------------------------------------------------------------------
# /predict_yield — chemprop + per-project XGBoost ensemble
# ---------------------------------------------------------------------------


class PredictYieldIn(BaseModel):
    # Per-item bound matches /train (TrainingPair.rxn_smiles uses
    # MAX_RXN_SMILES_LEN); without it /predict_yield bypasses the redaction
    # length contract that the rest of the pipeline enforces.
    rxn_smiles_list: list[
        Annotated[str, Field(min_length=3, max_length=MAX_RXN_SMILES_LEN)]
    ] = Field(min_length=1, max_length=100)
    project_internal_id: str | None = Field(default=None, max_length=200)
    model_id: str | None = Field(default=None, max_length=300)
    used_global_fallback: bool = False


class ReactionPrediction(BaseModel):
    rxn_smiles: str
    ensemble_mean: float
    ensemble_std: float
    components: dict[str, float]
    used_global_fallback: bool
    model_id: str | None


class PredictYieldOut(BaseModel):
    predictions: list[ReactionPrediction]


def _xgboost_predict(model: Any, vectors: list[list[float]]) -> list[float]:
    """Run XGBoost prediction. Accepts XGBRegressor or raw Booster (global)."""
    X = np.asarray(vectors, dtype=np.float64)
    if hasattr(model, "predict") and not _is_booster(model):
        preds = model.predict(X)
    else:
        preds = _booster_predict(model, X)
    return [float(p) for p in preds]


def _is_booster(model: Any) -> bool:
    try:
        import xgboost as xgb  # noqa: PLC0415

        return isinstance(model, xgb.Booster)
    except ImportError:
        return False


def _booster_predict(booster: Any, X: np.ndarray) -> np.ndarray:
    """Predict via raw xgboost.Booster (the global-fallback case)."""
    import xgboost as xgb  # noqa: PLC0415

    return booster.predict(xgb.DMatrix(X))


@app.post("/predict_yield", response_model=PredictYieldOut, tags=["yield_baseline"])
async def predict_yield(
    req: Annotated[PredictYieldIn, Body(...)],
) -> PredictYieldOut:
    if not req.rxn_smiles_list:
        raise ValueError("rxn_smiles_list must be non-empty")

    use_global = req.used_global_fallback or req.model_id is None
    if not use_global:
        model = _cache.get(req.model_id)  # type: ignore[arg-type]
        if model is None:
            raise HTTPException(
                status_code=412,
                detail=(
                    "needs_calibration: model_id not in cache "
                    "(restart or eviction); re-supply via /train"
                ),
            )
    else:
        if _GLOBAL_XGB_MODEL is None:
            raise HTTPException(status_code=503, detail="global_xgb_unavailable")
        model = _GLOBAL_XGB_MODEL

    try:
        vectors = await anyio.to_thread.run_sync(
            _encode_drfp_batch, req.rxn_smiles_list
        )
    except httpx.HTTPError as exc:
        log.warning("drfp upstream call failed", extra={"err": type(exc).__name__})
        raise HTTPException(status_code=503, detail="drfp_unavailable") from exc
    try:
        chem = await anyio.to_thread.run_sync(
            _call_chemprop_batch, req.rxn_smiles_list
        )
    except httpx.HTTPError as exc:
        log.warning("chemprop upstream call failed", extra={"err": type(exc).__name__})
        raise HTTPException(status_code=503, detail="chemprop_unavailable") from exc

    xgb_means = _xgboost_predict(model, vectors)

    rows = combine_batch(
        chemprop_means=[m for m, _ in chem],
        chemprop_stds=[s for _, s in chem],
        xgboost_means=xgb_means,
    )

    return PredictYieldOut(
        predictions=[
            ReactionPrediction(
                rxn_smiles=smi,
                ensemble_mean=row["ensemble_mean"],
                ensemble_std=row["ensemble_std"],
                components=row["components"],
                used_global_fallback=use_global,
                model_id=None if use_global else req.model_id,
            )
            for smi, row in zip(req.rxn_smiles_list, rows)
        ],
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_yield_baseline.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
