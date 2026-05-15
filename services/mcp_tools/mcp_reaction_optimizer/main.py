"""mcp-reaction-optimizer — closed-loop BoFire BO over reaction conditions (port 8018).

Stateless math service. Canonical state lives in optimization_campaigns +
optimization_rounds. The agent-claw builtin reads/writes those tables (RLS-
scoped) and passes Domain JSON + measured outcomes to this MCP.

Endpoints:
  POST /build_domain     — validates a request spec and returns the canonical
                            BoFire Domain JSON (used at campaign creation).
  POST /recommend_next   — given Domain JSON + prior measured_outcomes,
                            returns n_candidates next-batch proposals.
  POST /extract_pareto   — non-dominated subset of measured_outcomes.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator, Literal

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


def _bofire_version() -> str:
    try:
        import bofire  # noqa: PLC0415
        return getattr(bofire, "__version__", "unknown")
    except ImportError:
        return "unavailable"


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


class LinearConstraintSpec(BaseModel):
    """Linear inequality constraint over the continuous factors.

    sum_i (coefficient_i * factor_i) <= rhs   (when type='<=')
    sum_i (coefficient_i * factor_i) >= rhs   (when type='>=')
    sum_i (coefficient_i * factor_i)  = rhs   (when type='==')
    """
    type: Literal["<=", ">=", "=="] = "<="
    features: list[str] = Field(min_length=1, max_length=20)
    coefficients: list[float] = Field(min_length=1, max_length=20)
    rhs: float


class BuildDomainIn(BaseModel):
    factors: list[ContinuousFactor] = Field(default_factory=list, max_length=20)
    categorical_inputs: list[CategoricalInputSpec] = Field(default_factory=list, max_length=20)
    outputs: list[OutputSpec] = Field(min_length=1, max_length=10)
    constraints: list[LinearConstraintSpec] = Field(default_factory=list, max_length=20)


class BuildDomainOut(BaseModel):
    bofire_domain: dict[str, Any]
    n_inputs: int
    n_outputs: int
    n_constraints: int
    bofire_version: str


def _build_bofire_domain(
    factors: list[ContinuousFactor],
    cats: list[CategoricalInputSpec],
    outputs: list[OutputSpec],
    constraints: list[LinearConstraintSpec],
) -> Any:
    from bofire.data_models.constraints.api import (
        LinearEqualityConstraint,
        LinearInequalityConstraint,
    )
    from bofire.data_models.domain.api import Constraints, Domain, Inputs, Outputs
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

    cons: list[Any] = []
    for con in constraints:
        if len(con.features) != len(con.coefficients):
            raise ValueError(
                "constraint features and coefficients must have equal length"
            )
        if con.type == "==":
            cons.append(LinearEqualityConstraint(
                features=list(con.features),
                coefficients=[float(x) for x in con.coefficients],
                rhs=float(con.rhs),
            ))
        else:
            # BoFire LinearInequalityConstraint encodes a*x <= rhs by default.
            # Flip sign for >= so the same primitive serves both directions.
            sign = 1.0 if con.type == "<=" else -1.0
            cons.append(LinearInequalityConstraint(
                features=list(con.features),
                coefficients=[float(sign * x) for x in con.coefficients],
                rhs=float(sign * con.rhs),
            ))

    return Domain(
        inputs=Inputs(features=feats),
        outputs=Outputs(features=outs),
        constraints=Constraints(constraints=cons) if cons else Constraints(),
    )


@app.post("/build_domain", response_model=BuildDomainOut, tags=["reaction_optimizer"])
async def build_domain(req: Annotated[BuildDomainIn, Body(...)]) -> BuildDomainOut:
    if not req.factors and not req.categorical_inputs:
        raise HTTPException(
            status_code=422,
            detail="at least one factor or categorical_input must be provided",
        )
    try:
        domain = _build_bofire_domain(req.factors, req.categorical_inputs, req.outputs, req.constraints)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"infeasible_domain: {exc}") from exc

    return BuildDomainOut(
        bofire_domain=_domain_dump(domain),
        n_inputs=len(req.factors) + len(req.categorical_inputs),
        n_outputs=len(req.outputs),
        n_constraints=len(req.constraints),
        bofire_version=_bofire_version(),
    )


def _domain_dump(domain: Any) -> dict[str, Any]:
    """Serialize Domain to a JSON-safe dict."""
    import json

    return json.loads(domain.model_dump_json())


def _domain_load(payload: dict[str, Any]) -> Any:
    """Reconstruct a Domain from its JSON dump.

    Uses Pydantic-v2's ``model_validate`` instead of ``Domain(**payload)`` —
    equivalent at runtime today but cleaner against future BoFire schema
    changes (discriminated unions, alias generators) that don't survive
    kwargs unpacking but do survive structured validation.
    """
    from bofire.data_models.domain.api import Domain
    return Domain.model_validate(payload)


# ---------------------------------------------------------------------------
# /recommend_next
# ---------------------------------------------------------------------------

class MeasuredItem(BaseModel):
    factor_values: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, float] = Field(default_factory=dict)


SupportedStrategy = Literal["SoboStrategy", "MoboStrategy", "RandomStrategy", "QnehviStrategy"]
SupportedAcquisition = Literal["qLogEI", "qLogNEI", "qNEHVI", "qEHVI", "random"]


class RecommendNextIn(BaseModel):
    bofire_domain: dict[str, Any]
    measured_outcomes: list[MeasuredItem] = Field(default_factory=list, max_length=10_000)
    n_candidates: int = Field(default=8, ge=1, le=200)
    seed: int = Field(default=42)
    strategy: SupportedStrategy = "SoboStrategy"
    acquisition: SupportedAcquisition = "qLogEI"
    min_observations_for_bo: int = Field(default=_opt.MIN_OBSERVATIONS_FOR_BO, ge=1, le=1000)
    # Gower distance threshold in [0, 1]. Candidates within this distance of any
    # measured point are rejected and replaced by random resamples. None = disabled.
    min_distance_from_measured: float | None = Field(default=None, ge=0.0, le=1.0)


class ProposalOut(BaseModel):
    factor_values: dict[str, Any]
    source: str


class RecommendNextOut(BaseModel):
    proposals: list[ProposalOut]
    n_observations: int
    used_bo: bool
    fallback_reason: str | None = None
    strategy: str
    acquisition: str


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

    # Validate measured factor / output keys against the Domain so a typo
    # ("temp_c" instead of "temperature_c") fails loudly here instead of
    # being silently dropped in measured_to_dataframe / strategy.tell.
    declared_inputs = _opt.domain_input_keys(domain)
    declared_outputs = _opt.domain_output_keys(domain)
    for idx, item in enumerate(req.measured_outcomes):
        unknown_inputs = set(item.factor_values.keys()) - declared_inputs
        if unknown_inputs:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"measured_outcomes[{idx}] has factor keys "
                    f"{sorted(unknown_inputs)} not in Domain.inputs (declared: "
                    f"{sorted(declared_inputs)})"
                ),
            )
        unknown_outputs = set(item.outputs.keys()) - declared_outputs
        if unknown_outputs:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"measured_outcomes[{idx}] has output keys "
                    f"{sorted(unknown_outputs)} not in Domain.outputs (declared: "
                    f"{sorted(declared_outputs)})"
                ),
            )
        for name, val in item.outputs.items():
            if not (val == val) or val in (float("inf"), float("-inf")):  # NaN/inf check
                raise HTTPException(
                    status_code=422,
                    detail=f"measured_outcomes[{idx}].outputs[{name!r}] is not finite",
                )

    measured = [m.model_dump() for m in req.measured_outcomes]
    proposals, fallback_reason = _opt.recommend_next_batch(
        domain=domain,
        measured_outcomes=measured,
        n_candidates=req.n_candidates,
        seed=req.seed,
        strategy=req.strategy,
        acquisition=req.acquisition,
        min_observations_for_bo=req.min_observations_for_bo,
        min_distance_from_measured=req.min_distance_from_measured,
    )
    used_bo = (
        len(measured) >= req.min_observations_for_bo
        and any(p["source"] in _opt.ALL_BO_ACQS for p in proposals)
    )
    return RecommendNextOut(
        proposals=[ProposalOut(**p) for p in proposals],
        n_observations=len(measured),
        used_bo=used_bo,
        fallback_reason=fallback_reason,
        strategy=req.strategy,
        acquisition=req.acquisition,
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
