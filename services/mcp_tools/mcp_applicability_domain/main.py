"""mcp-applicability-domain — three-signal AD verdict service (port 8017).

Tools:
- POST /calibrate  — supply per-project residuals, get a calibration_id (cached)
- POST /assess     — three-signal AD verdict given a query DRFP vector +
                     nearest-neighbor distance + (calibration_id or inline residuals)

Stateless math + an LRU cache of per-project calibration sets (30-min TTL).
The DB lives in agent-claw, not here.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, AsyncIterator

import numpy as np
from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-applicability-domain")
settings = ToolSettings()

_STATS_PATH = Path(os.environ.get(
    "MCP_AD_STATS_PATH",
    str(Path(__file__).parent / "data" / "drfp_stats_v1.json"),
))

_STATS: dict[str, Any] | None = None


def _load_stats() -> dict[str, Any] | None:
    if not _STATS_PATH.exists():
        return None
    with _STATS_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def _is_ready() -> bool:
    return _STATS is not None


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Load drfp_stats artifact on startup."""
    global _STATS
    _STATS = _load_stats()
    yield


app = create_app(
    name="mcp-applicability-domain",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_applicability_domain:invoke",
    lifespan=_lifespan,
)


# ---------------------------------------------------------------------------
# /calibrate — server-side LRU cache of per-project conformal calibration sets
# ---------------------------------------------------------------------------

_CALIBRATION_CACHE: dict[str, dict[str, Any]] = {}
_CALIBRATION_TTL_SEC = 30 * 60
_CALIBRATION_CAP = 256


def _calibration_id(project_id: str, residuals: list[float]) -> str:
    """Deterministic id from (project_id, sorted residuals)."""
    h = hashlib.sha256()
    h.update(project_id.encode("utf-8"))
    for r in sorted(residuals):
        h.update(f"{r:.6f}|".encode("ascii"))
    return h.hexdigest()[:16]


def _evict_expired() -> None:
    now = time.time()
    expired = [k for k, v in _CALIBRATION_CACHE.items() if v["expires_at"] < now]
    for k in expired:
        del _CALIBRATION_CACHE[k]
    while len(_CALIBRATION_CACHE) > _CALIBRATION_CAP:
        oldest_k = min(_CALIBRATION_CACHE, key=lambda k: _CALIBRATION_CACHE[k]["expires_at"])
        del _CALIBRATION_CACHE[oldest_k]


class CalibrateIn(BaseModel):
    project_id: str = Field(min_length=1, max_length=64)
    residuals: list[float] = Field(min_length=1, max_length=1000)


class CalibrateOut(BaseModel):
    calibration_id: str
    calibration_size: int
    cached_for_seconds: int


@app.post(
    "/calibrate",
    response_model=CalibrateOut,
    tags=["applicability_domain"],
)
async def calibrate(
    req: Annotated[CalibrateIn, Body(...)],
) -> CalibrateOut:
    if any(r < 0 for r in req.residuals):
        raise ValueError("residuals must be non-negative (|true - predicted|)")
    if any(math.isnan(r) or math.isinf(r) for r in req.residuals):
        raise ValueError("residuals must be finite numbers")

    cid = _calibration_id(req.project_id, req.residuals)
    _evict_expired()
    _CALIBRATION_CACHE[cid] = {
        "residuals": list(req.residuals),
        "expires_at": time.time() + _CALIBRATION_TTL_SEC,
    }
    return CalibrateOut(
        calibration_id=cid,
        calibration_size=len(req.residuals),
        cached_for_seconds=_CALIBRATION_TTL_SEC,
    )


# ---------------------------------------------------------------------------
# /assess — 3-signal verdict
# ---------------------------------------------------------------------------

# Tanimoto / DRFP-distance bands (cosine distance on binary fingerprints).
_TANIMOTO_THRESHOLD_IN = 0.50
_TANIMOTO_THRESHOLD_OUT = 0.70

# Conformal interval width (yield-percentage points).
_CONFORMAL_ALPHA = 0.20  # 80% nominal coverage
_CONFORMAL_THRESHOLD_IN = 30.0
_CONFORMAL_THRESHOLD_OUT = 50.0
_CONFORMAL_MIN_N = 30


class AssessIn(BaseModel):
    query_drfp_vector: list[float] = Field(min_length=2048, max_length=2048)
    nearest_neighbor_distance: float = Field(ge=0.0, le=1.0)
    calibration_id: str | None = Field(default=None, max_length=64)
    inline_residuals: list[float] = Field(default_factory=list, max_length=1000)


class TanimotoSignal(BaseModel):
    distance: float
    tanimoto: float
    threshold_in: float
    threshold_out: float
    in_band: bool


class MahalanobisSignal(BaseModel):
    mahalanobis: float
    threshold_in: float
    threshold_out: float
    in_band: bool
    stats_version: str
    n_train: int


class ConformalSignal(BaseModel):
    alpha: float
    half_width: float
    calibration_size: int
    used_global_fallback: bool
    threshold_in: float
    threshold_out: float
    in_band: bool


class AssessOut(BaseModel):
    verdict: str
    tanimoto_signal: TanimotoSignal
    mahalanobis_signal: MahalanobisSignal
    conformal_signal: ConformalSignal | None
    used_global_fallback: bool


def _resolve_residuals(req: AssessIn) -> tuple[list[float], bool]:
    """Return (residuals, used_global_fallback_marker_from_caller)."""
    if req.calibration_id is not None:
        _evict_expired()
        entry = _CALIBRATION_CACHE.get(req.calibration_id)
        if entry is None:
            raise HTTPException(
                status_code=404,
                detail="calibration_id_unknown — re-supply via /calibrate and retry",
            )
        return entry["residuals"], False
    return list(req.inline_residuals), True


def _tanimoto_signal(distance: float) -> TanimotoSignal:
    return TanimotoSignal(
        distance=distance,
        tanimoto=1.0 - distance,
        threshold_in=_TANIMOTO_THRESHOLD_IN,
        threshold_out=_TANIMOTO_THRESHOLD_OUT,
        in_band=distance <= _TANIMOTO_THRESHOLD_IN,
    )


def _mahalanobis_signal(query: list[float]) -> MahalanobisSignal:
    assert _STATS is not None
    x = np.asarray(query, dtype=np.float64)
    mu = np.asarray(_STATS["mean"], dtype=np.float64)
    var = np.asarray(_STATS["var_diag"], dtype=np.float64)
    diff = x - mu
    m_dist = float(np.sum((diff * diff) / var))
    return MahalanobisSignal(
        mahalanobis=m_dist,
        threshold_in=float(_STATS["threshold_in"]),
        threshold_out=float(_STATS["threshold_out"]),
        in_band=m_dist <= float(_STATS["threshold_in"]),
        stats_version=str(_STATS.get("version", "drfp_stats_v1")),
        n_train=int(_STATS["n_train"]),
    )


def _conformal_signal(residuals: list[float], used_fallback: bool) -> ConformalSignal | None:
    n = len(residuals)
    if n < _CONFORMAL_MIN_N:
        return None
    arr = np.asarray(residuals, dtype=np.float64)
    half_width = float(np.quantile(arr, 1.0 - _CONFORMAL_ALPHA))
    return ConformalSignal(
        alpha=_CONFORMAL_ALPHA,
        half_width=half_width,
        calibration_size=n,
        used_global_fallback=used_fallback,
        threshold_in=_CONFORMAL_THRESHOLD_IN,
        threshold_out=_CONFORMAL_THRESHOLD_OUT,
        in_band=half_width <= _CONFORMAL_THRESHOLD_IN,
    )


def _aggregate_verdict(
    t: TanimotoSignal,
    m: MahalanobisSignal,
    c: ConformalSignal | None,
) -> str:
    in_band_count = (1 if t.in_band else 0) + (1 if m.in_band else 0) + (1 if c and c.in_band else 0)
    usable = 3 if c is not None else 2
    if in_band_count == usable:
        return "in_domain"
    # ceil(usable/2) → 2 of 3, 1 of 2.
    if in_band_count >= -(-usable // 2):
        return "borderline"
    return "out_of_domain"


@app.post(
    "/assess",
    response_model=AssessOut,
    tags=["applicability_domain"],
)
async def assess(
    req: Annotated[AssessIn, Body(...)],
) -> AssessOut:
    if _STATS is None:
        raise HTTPException(status_code=503, detail="drfp_stats artifact not loaded")
    residuals, used_inline = _resolve_residuals(req)
    t = _tanimoto_signal(req.nearest_neighbor_distance)
    m = _mahalanobis_signal(req.query_drfp_vector)
    c = _conformal_signal(residuals, used_inline)
    used_fallback = (c is None) or used_inline
    verdict = _aggregate_verdict(t, m, c)
    return AssessOut(
        verdict=verdict,
        tanimoto_signal=t,
        mahalanobis_signal=m,
        conformal_signal=c,
        used_global_fallback=used_fallback,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_applicability_domain.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
