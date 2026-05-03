"""mcp-reaction-optimizer — closed-loop BoFire BO over reaction conditions (port 8018).

Stateless math service. Canonical state lives in optimization_campaigns +
optimization_rounds. The agent-claw builtin reads/writes those tables (RLS-
scoped) and passes Domain JSON + measured outcomes to this MCP.

Endpoints:
  POST /build_domain     — validates a request spec and returns the canonical
                            BoFire Domain JSON (used at campaign creation).
  POST /recommend_next   — given Domain JSON + prior measured_outcomes,
                            returns n_candidates next-batch proposals.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator

from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings
from services.mcp_tools.mcp_reaction_optimizer import optimizer as _opt

log = logging.getLogger("mcp-reaction-optimizer")
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
    name="mcp-reaction-optimizer",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_reaction_optimizer:invoke",
    lifespan=_lifespan,
)


# ---------------------------------------------------------------------------
# /build_domain
# ---------------------------------------------------------------------------

class ContinuousFactor(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    type: str = Field(pattern="^continuous$")
    range: list[float] = Field(min_length=2, max_length=2)


class CategoricalInputSpec(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    values: list[str] = Field(min_length=1, max_length=200)


class OutputSpec(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    direction: str = Field(default="maximize", pattern="^(maximize|minimize)$")


class BuildDomainIn(BaseModel):
    factors: list[ContinuousFactor] = Field(default_factory=list, max_length=20)
    categorical_inputs: list[CategoricalInputSpec] = Field(default_factory=list, max_length=20)
    outputs: list[OutputSpec] = Field(min_length=1, max_length=10)


class BuildDomainOut(BaseModel):
    bofire_domain: dict[str, Any]
    n_inputs: int
    n_outputs: int


def _build_bofire_domain(
    factors: list[ContinuousFactor],
    cats: list[CategoricalInputSpec],
    outputs: list[OutputSpec],
) -> Any:
    from bofire.data_models.domain.api import Domain, Inputs, Outputs
    from bofire.data_models.features.api import (
        CategoricalInput, ContinuousInput, ContinuousOutput,
    )
    from bofire.data_models.objectives.api import (
        MaximizeObjective, MinimizeObjective,
    )

    feats: list[Any] = []
    for f in factors:
        feats.append(ContinuousInput(key=f.name, bounds=(float(f.range[0]), float(f.range[1]))))
    for c in cats:
        feats.append(CategoricalInput(key=c.name, categories=list(c.values)))

    outs: list[Any] = []
    for o in outputs:
        if o.direction == "maximize":
            outs.append(ContinuousOutput(key=o.name, objective=MaximizeObjective(w=1.0)))
        else:
            outs.append(ContinuousOutput(key=o.name, objective=MinimizeObjective(w=1.0)))

    return Domain(inputs=Inputs(features=feats), outputs=Outputs(features=outs))


@app.post("/build_domain", response_model=BuildDomainOut, tags=["reaction_optimizer"])
async def build_domain(req: Annotated[BuildDomainIn, Body(...)]) -> BuildDomainOut:
    if not req.factors and not req.categorical_inputs:
        raise HTTPException(
            status_code=422,
            detail="at least one factor or categorical_input must be provided",
        )
    try:
        domain = _build_bofire_domain(req.factors, req.categorical_inputs, req.outputs)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"infeasible_domain: {exc}") from exc

    return BuildDomainOut(
        bofire_domain=_domain_dump(domain),
        n_inputs=len(req.factors) + len(req.categorical_inputs),
        n_outputs=len(req.outputs),
    )


def _domain_dump(domain: Any) -> dict[str, Any]:
    """Serialize Domain to a JSON-safe dict."""
    import json

    return json.loads(domain.model_dump_json())


def _domain_load(payload: dict[str, Any]) -> Any:
    """Reconstruct a Domain from its JSON dump."""
    from bofire.data_models.domain.api import Domain
    return Domain(**payload)


# ---------------------------------------------------------------------------
# /recommend_next
# ---------------------------------------------------------------------------

class MeasuredItem(BaseModel):
    factor_values: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, float] = Field(default_factory=dict)


class RecommendNextIn(BaseModel):
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


@app.post("/recommend_next", response_model=RecommendNextOut, tags=["reaction_optimizer"])
async def recommend_next(
    req: Annotated[RecommendNextIn, Body(...)],
) -> RecommendNextOut:
    try:
        domain = _domain_load(req.bofire_domain)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=422,
            detail=f"invalid_bofire_domain: {exc}",
        ) from exc

    measured = [m.model_dump() for m in req.measured_outcomes]
    proposals = _opt.recommend_next_batch(
        domain=domain,
        measured_outcomes=measured,
        n_candidates=req.n_candidates,
        seed=req.seed,
    )
    used_bo = len(measured) >= _opt.MIN_OBSERVATIONS_FOR_BO and any(
        p["source"] == "qLogEI" for p in proposals
    )
    return RecommendNextOut(
        proposals=[ProposalOut(**p) for p in proposals],
        n_observations=len(measured),
        used_bo=used_bo,
    )


# ---------------------------------------------------------------------------
# /extract_pareto (Z6)
# ---------------------------------------------------------------------------

class ExtractParetoIn(BaseModel):
    measured_outcomes: list[MeasuredItem] = Field(min_length=1, max_length=10_000)
    output_directions: dict[str, str] = Field(min_length=1)


class ExtractParetoOut(BaseModel):
    pareto: list[MeasuredItem]
    n_total: int
    n_pareto: int
    output_directions: dict[str, str]


@app.post("/extract_pareto", response_model=ExtractParetoOut, tags=["reaction_optimizer"])
async def extract_pareto(
    req: Annotated[ExtractParetoIn, Body(...)],
) -> ExtractParetoOut:
    for direction in req.output_directions.values():
        if direction not in ("maximize", "minimize"):
            raise HTTPException(
                status_code=422,
                detail=f"output_directions values must be 'maximize' or 'minimize'; got {direction!r}",
            )

    measured = [m.model_dump() for m in req.measured_outcomes]
    pareto = _opt.pareto_front(measured, req.output_directions)
    return ExtractParetoOut(
        pareto=[MeasuredItem(**p) for p in pareto],
        n_total=len(measured),
        n_pareto=len(pareto),
        output_directions=req.output_directions,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_reaction_optimizer.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
