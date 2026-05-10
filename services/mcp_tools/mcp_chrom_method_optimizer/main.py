"""mcp-chrom-method-optimizer — closed-loop BoFire BO over HPLC method
parameters (port 8019).

Stateless math service. Canonical state lives in optimization_campaigns +
optimization_rounds and analytical_methods (see db/init/54_*, 55_*). The
agent-claw builtin reads / writes those tables (RLS-scoped) and passes
Domain JSON + measured outcomes to this MCP.

Endpoints:
  POST /build_domain         — chromatography-aware sugar over a BoFire
                                 Domain build (column descriptors, gradient
                                 scheme, monotonicity constraint).
  POST /recommend_next       — given Domain JSON + measured outcomes,
                                 returns n_candidates next-batch proposals.
  POST /materialize_method   — expand a proposal's gradient-shape factors
                                 into an explicit (time_min, pctB) gradient
                                 program ready for an instrument.
  POST /score_chromatogram   — Phase 2; returns 501 in Phase 1.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator

from fastapi import Body, FastAPI, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings
from services.mcp_tools.mcp_chrom_method_optimizer import domain_builder as _db
from services.mcp_tools.mcp_chrom_method_optimizer import optimizer as _opt

log = logging.getLogger("mcp-chrom-method-optimizer")
settings = ToolSettings()


def _is_ready() -> bool:
    try:
        import bofire  # noqa: F401, PLC0415
        return True
    except ImportError:
        return False


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield


app = create_app(
    name="mcp-chrom-method-optimizer",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_chrom_method_optimizer:invoke",
    lifespan=_lifespan,
)


# ---------------------------------------------------------------------------
# /build_domain
# ---------------------------------------------------------------------------

class BuildDomainIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gradient_scheme: str = Field(default="hold_ramp_hold")
    n_segments: int = Field(default=3, ge=1, le=5)
    column_choices: list[str] = Field(min_length=1, max_length=50)
    column_descriptors: list[list[float]] = Field(min_length=1, max_length=50)
    b_solvent_choices: list[str] = Field(min_length=1, max_length=10)
    additive_choices: list[str] = Field(min_length=1, max_length=10)
    flow_bounds_mLmin: tuple[float, float] = (0.2, 1.0)
    T_bounds_C: tuple[float, float] = (25.0, 55.0)
    objective_mode: str = Field(default="single")


class BuildDomainOut(BaseModel):
    bofire_domain: dict[str, Any]
    n_inputs: int
    n_outputs: int
    gradient_scheme: str
    objective_mode: str


def _domain_dump(domain: Any) -> dict[str, Any]:
    import json
    return json.loads(domain.model_dump_json())


def _domain_load(payload: dict[str, Any]) -> Any:
    from bofire.data_models.domain.api import Domain
    return Domain.model_validate(payload)


@app.post("/build_domain", response_model=BuildDomainOut, tags=["chrom_method_optimizer"])
async def build_domain(
    req: Annotated[BuildDomainIn, Body(...)],
) -> BuildDomainOut:
    try:
        scheme = _db.GradientScheme(req.gradient_scheme)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"unknown_gradient_scheme: {exc}") from exc
    try:
        mode = _db.ObjectiveMode(req.objective_mode)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"unknown_objective_mode: {exc}") from exc

    try:
        domain = _db.build_chrom_domain(
            gradient_scheme=scheme,
            column_choices=req.column_choices,
            column_descriptors=req.column_descriptors,
            b_solvent_choices=req.b_solvent_choices,
            additive_choices=req.additive_choices,
            flow_bounds_mLmin=req.flow_bounds_mLmin,
            T_bounds_C=req.T_bounds_C,
            objective_mode=mode,
            n_segments=req.n_segments,
        )
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=f"deferred: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"infeasible_domain: {exc}") from exc

    n_inputs = len(domain.inputs.features) if hasattr(domain.inputs, "features") else 0
    n_outputs = len(domain.outputs.features) if hasattr(domain.outputs, "features") else 0

    return BuildDomainOut(
        bofire_domain=_domain_dump(domain),
        n_inputs=n_inputs,
        n_outputs=n_outputs,
        gradient_scheme=req.gradient_scheme,
        objective_mode=req.objective_mode,
    )


# ---------------------------------------------------------------------------
# /recommend_next
# ---------------------------------------------------------------------------

class MeasuredItem(BaseModel):
    factor_values: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, float] = Field(default_factory=dict)


class RecommendNextIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bofire_domain: dict[str, Any]
    measured_outcomes: list[MeasuredItem] = Field(default_factory=list, max_length=10_000)
    n_candidates: int = Field(default=8, ge=1, le=200)
    seed: int = Field(default=42)


class ProposalOut(BaseModel):
    factor_values: dict[str, Any]
    source: str


class RecommendNextOut(BaseModel):
    proposals: list[ProposalOut]
    n_observations: int
    used_bo: bool


@app.post("/recommend_next", response_model=RecommendNextOut, tags=["chrom_method_optimizer"])
async def recommend_next(
    req: Annotated[RecommendNextIn, Body(...)],
) -> RecommendNextOut:
    try:
        domain = _domain_load(req.bofire_domain)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=422, detail=f"invalid_bofire_domain: {exc}"
        ) from exc

    measured = [m.model_dump() for m in req.measured_outcomes]
    proposals = _opt.recommend_next_batch(
        domain=domain,
        measured_outcomes=measured,
        n_candidates=req.n_candidates,
        seed=req.seed,
    )
    _bo_sources = {"qLogEI", "qLogNEI", "qNEHVI", "qEHVI"}
    used_bo = len(measured) >= _opt.MIN_OBSERVATIONS_FOR_BO and any(
        p["source"] in _bo_sources for p in proposals
    )
    return RecommendNextOut(
        proposals=[ProposalOut(**p) for p in proposals],
        n_observations=len(measured),
        used_bo=used_bo,
    )


# ---------------------------------------------------------------------------
# /materialize_method
# ---------------------------------------------------------------------------

class MaterializeMethodIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    factor_values: dict[str, Any]
    gradient_scheme: str = Field(default="hold_ramp_hold")
    detection_mode: str = Field(default="DAD")
    technique: str = Field(default="RP-UHPLC")


class MaterializeMethodOut(BaseModel):
    technique: str
    column: str
    b_solvent: str
    additive: str
    flow_mLmin: float
    T_col_C: float
    detection_mode: str
    gradient_program: list[dict[str, float]]
    total_runtime_min: float


@app.post(
    "/materialize_method",
    response_model=MaterializeMethodOut,
    tags=["chrom_method_optimizer"],
)
async def materialize_method(
    req: Annotated[MaterializeMethodIn, Body(...)],
) -> MaterializeMethodOut:
    try:
        scheme = _db.GradientScheme(req.gradient_scheme)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"unknown_gradient_scheme: {exc}") from exc

    try:
        program = _db.materialize_gradient_program(req.factor_values, scheme)
    except KeyError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"factor_values missing required field: {exc.args[0]!r}",
        ) from exc
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=f"deferred: {exc}") from exc

    fv = req.factor_values
    try:
        column = str(fv["column"])
        b_solvent = str(fv["b_solvent"])
        additive = str(fv["additive"])
        flow = float(fv["flow_mLmin"])
        T = float(fv["T_col_C"])
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=422, detail=f"factor_values incomplete: {exc}"
        ) from exc

    return MaterializeMethodOut(
        technique=req.technique,
        column=column,
        b_solvent=b_solvent,
        additive=additive,
        flow_mLmin=flow,
        T_col_C=T,
        detection_mode=req.detection_mode,
        gradient_program=program,
        total_runtime_min=program[-1]["time_min"] if program else 0.0,
    )


# ---------------------------------------------------------------------------
# /score_chromatogram (Phase 2 — stub)
# ---------------------------------------------------------------------------

class ScoreChromatogramIn(BaseModel):
    model_config = ConfigDict(extra="allow")
    peaks: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/score_chromatogram", tags=["chrom_method_optimizer"])
async def score_chromatogram(
    req: Annotated[ScoreChromatogramIn, Body(...)],
) -> dict[str, Any]:
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="score_chromatogram is Phase 2 — peak tracker + Niezen-Desmet CRF not yet wired",
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_chrom_method_optimizer.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
