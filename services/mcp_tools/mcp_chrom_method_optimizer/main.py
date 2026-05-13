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

from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings
from services.mcp_tools.mcp_chrom_method_optimizer import domain_builder as _db
from services.mcp_tools.mcp_chrom_method_optimizer import optimizer as _opt
from services.mcp_tools.mcp_chrom_method_optimizer import peak_tracker as _pt
from services.mcp_tools.mcp_chrom_method_optimizer import retention_lss as _lss
from services.mcp_tools.mcp_chrom_method_optimizer import scorer as _scorer

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
    # b_solvent_choices only used in binary eluent mode; default keeps the
    # binary path working when callers omit it in ternary mode.
    b_solvent_choices: list[str] = Field(default_factory=lambda: ["MeCN", "MeOH"], max_length=10)
    additive_choices: list[str] = Field(min_length=1, max_length=10)
    flow_bounds_mLmin: tuple[float, float] = (0.2, 1.0)
    T_bounds_C: tuple[float, float] = (25.0, 55.0)
    objective_mode: str = Field(default="single")
    eluent_mode: str = Field(default="binary")


class BuildDomainOut(BaseModel):
    bofire_domain: dict[str, Any]
    n_inputs: int
    n_outputs: int
    gradient_scheme: str
    objective_mode: str
    eluent_mode: str
    n_segments: int


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
        eluent = _db.EluentMode(req.eluent_mode)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"unknown_eluent_mode: {exc}") from exc

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
            eluent_mode=eluent,
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
        eluent_mode=req.eluent_mode,
        n_segments=req.n_segments,
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
    n_segments: int = Field(default=3, ge=1, le=5)
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
        program = _db.materialize_gradient_program(
            req.factor_values, scheme, n_segments=req.n_segments,
        )
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
        additive = str(fv["additive"])
        flow = float(fv["flow_mLmin"])
        T = float(fv["T_col_C"])
        # Binary mode → b_solvent categorical; ternary mode → b_meoh_fraction.
        if "b_solvent" in fv:
            b_solvent = str(fv["b_solvent"])
        elif "b_meoh_fraction" in fv:
            x = float(fv["b_meoh_fraction"])
            b_solvent = f"MeCN:MeOH {round((1.0 - x) * 100)}:{round(x * 100)}"
        else:
            raise KeyError("b_solvent")
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
# /score_chromatogram  (Phase 2)
# ---------------------------------------------------------------------------

class TargetCompound(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    m_z: float | None = None


class ScoreChromatogramIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # One chromatogram's detected peaks. Each peak: at least rt_min, plus
    # any of {width_baseline_min, width_min, fwhm_min, area, height} for
    # width estimation, plus optional name / m_z for target tracking.
    peaks: list[dict[str, Any]] = Field(default_factory=list, max_length=2000)
    # Optional known target compounds — resolution is then computed over the
    # matched target set rather than over all adjacent peaks.
    targets: list[TargetCompound] = Field(default_factory=list, max_length=200)
    rs_target: float = Field(default=_scorer.DEFAULT_RS_TARGET, gt=0)
    runtime_target_min: float = Field(default=_scorer.DEFAULT_RUNTIME_TARGET_MIN, gt=0)
    # Method context for the runtime / solvent-PMI terms (optional).
    runtime_min: float | None = None
    b_solvent: str | None = None
    flow_mLmin: float | None = None
    avg_pctB: float | None = None
    mz_tolerance: float = Field(default=_pt.DEFAULT_MZ_TOLERANCE, gt=0)


class ScoreChromatogramOut(BaseModel):
    crf_total: float
    min_resolution: float
    n_resolved_pairs: int
    n_peaks: int
    runtime_min: float
    solvent_pmi_g: float
    resolutions: list[float]
    resolution_target_met: bool
    tracking_confidence: str
    unmatched_targets: list[str]


@app.post(
    "/score_chromatogram",
    response_model=ScoreChromatogramOut,
    tags=["chrom_method_optimizer"],
)
async def score_chromatogram(
    req: Annotated[ScoreChromatogramIn, Body(...)],
) -> ScoreChromatogramOut:
    targets = [t.model_dump() for t in req.targets]
    if targets:
        m = _pt.match_targets(req.peaks, targets, mz_tolerance=req.mz_tolerance)
        scored_peaks = list(m["matched"].values())
        confidence = m["confidence"]
        unmatched = m["unmatched_targets"]
    else:
        scored_peaks = list(req.peaks)
        confidence = "high"
        unmatched = []

    result = _scorer.score_chromatogram(
        scored_peaks,
        rs_target=req.rs_target,
        runtime_target_min=req.runtime_target_min,
        runtime_min=req.runtime_min,
        b_solvent=req.b_solvent,
        flow_mLmin=req.flow_mLmin,
        avg_pctB=req.avg_pctB,
    )
    return ScoreChromatogramOut(
        **result,
        tracking_confidence=confidence,
        unmatched_targets=unmatched,
    )


# ---------------------------------------------------------------------------
# /extract_pareto  (Phase 3 — multi-objective)
# ---------------------------------------------------------------------------

class ExtractParetoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    measured_outcomes: list[MeasuredItem] = Field(min_length=1, max_length=10_000)
    # e.g. {"min_resolution": "maximize", "runtime_min": "minimize",
    #       "solvent_pmi_g": "minimize"}
    output_directions: dict[str, str] = Field(min_length=1)


class ExtractParetoOut(BaseModel):
    pareto: list[MeasuredItem]
    n_total: int
    n_pareto: int
    output_directions: dict[str, str]


@app.post("/extract_pareto", response_model=ExtractParetoOut, tags=["chrom_method_optimizer"])
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


# ---------------------------------------------------------------------------
# /simulate_retention  (Phase 5 — LSS cheap-fidelity)
# ---------------------------------------------------------------------------

class SimulateRetentionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Provide EITHER fitted LSS params per analyte …
    lss_by_analyte: dict[str, tuple[float, float]] | None = None
    # … OR isocratic scouting observations per analyte (phi, t_R pairs),
    # which we fit to (log10_kw, S) first.
    scouting_observations: dict[str, list[tuple[float, float]]] | None = None
    gradient_program: list[dict[str, float]] = Field(min_length=2)
    t0_min: float = Field(gt=0)
    t_dwell_min: float = Field(default=0.0, ge=0)
    plate_count: int = Field(default=_lss.DEFAULT_PLATE_COUNT, gt=0)
    # Optional method context — forwarded to the CRF scorer.
    rs_target: float = Field(default=_scorer.DEFAULT_RS_TARGET, gt=0)
    runtime_target_min: float = Field(default=_scorer.DEFAULT_RUNTIME_TARGET_MIN, gt=0)
    b_solvent: str | None = None
    flow_mLmin: float | None = None
    avg_pctB: float | None = None


class SimulateRetentionOut(BaseModel):
    peaks: list[dict[str, Any]]
    lss_by_analyte: dict[str, tuple[float, float]]
    crf_total: float
    min_resolution: float
    runtime_min: float
    solvent_pmi_g: float
    n_eluted: int
    n_analytes: int


def _resolve_lss(req: SimulateRetentionIn) -> dict[str, tuple[float, float]]:
    if req.lss_by_analyte:
        return {k: (float(v[0]), float(v[1])) for k, v in req.lss_by_analyte.items()}
    if req.scouting_observations:
        fitted: dict[str, tuple[float, float]] = {}
        for name, obs in req.scouting_observations.items():
            pairs = [(float(a), float(b)) for a, b in obs]
            res = _lss.fit_lss_isocratic(pairs, req.t0_min)
            if res is not None:
                fitted[name] = res
        if not fitted:
            raise HTTPException(
                status_code=422,
                detail="no analyte LSS could be fitted (need ≥ 2 distinct phi with retained peaks)",
            )
        return fitted
    raise HTTPException(
        status_code=422,
        detail="provide either lss_by_analyte or scouting_observations",
    )


@app.post(
    "/simulate_retention",
    response_model=SimulateRetentionOut,
    tags=["chrom_method_optimizer"],
)
async def simulate_retention(
    req: Annotated[SimulateRetentionIn, Body(...)],
) -> SimulateRetentionOut:
    lss = _resolve_lss(req)
    peaks = _lss.simulate_chromatogram(
        lss, req.gradient_program, req.t0_min,
        plate_count=req.plate_count, t_dwell_min=req.t_dwell_min,
    )
    scored = _scorer.score_chromatogram(
        peaks,
        rs_target=req.rs_target,
        runtime_target_min=req.runtime_target_min,
        b_solvent=req.b_solvent,
        flow_mLmin=req.flow_mLmin,
        avg_pctB=req.avg_pctB,
    )
    return SimulateRetentionOut(
        peaks=peaks,
        lss_by_analyte=lss,
        crf_total=scored["crf_total"],
        min_resolution=scored["min_resolution"],
        runtime_min=scored["runtime_min"],
        solvent_pmi_g=scored["solvent_pmi_g"],
        n_eluted=len(peaks),
        n_analytes=len(lss),
    )


# ---------------------------------------------------------------------------
# /seed_candidates_lss  (Phase 5 — rank cold-start candidates by simulated CRF)
# ---------------------------------------------------------------------------

class SeedCandidatesLssIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lss_by_analyte: dict[str, tuple[float, float]]
    candidate_factor_values: list[dict[str, Any]] = Field(min_length=1, max_length=20_000)
    gradient_scheme: str = Field(default="hold_ramp_hold")
    n_segments: int = Field(default=3, ge=1, le=5)
    t0_min: float = Field(gt=0)
    t_dwell_min: float = Field(default=0.0, ge=0)
    plate_count: int = Field(default=_lss.DEFAULT_PLATE_COUNT, gt=0)
    rs_target: float = Field(default=_scorer.DEFAULT_RS_TARGET, gt=0)
    runtime_target_min: float = Field(default=_scorer.DEFAULT_RUNTIME_TARGET_MIN, gt=0)
    top_k: int = Field(default=8, ge=1, le=200)


class RankedCandidate(BaseModel):
    factor_values: dict[str, Any]
    simulated_crf: float
    simulated_min_resolution: float
    simulated_runtime_min: float
    n_eluted: int


class SeedCandidatesLssOut(BaseModel):
    ranked: list[RankedCandidate]
    n_scored: int
    n_analytes: int


@app.post(
    "/seed_candidates_lss",
    response_model=SeedCandidatesLssOut,
    tags=["chrom_method_optimizer"],
)
async def seed_candidates_lss(
    req: Annotated[SeedCandidatesLssIn, Body(...)],
) -> SeedCandidatesLssOut:
    try:
        scheme = _db.GradientScheme(req.gradient_scheme)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"unknown_gradient_scheme: {exc}") from exc

    lss = {k: (float(v[0]), float(v[1])) for k, v in req.lss_by_analyte.items()}
    scored: list[RankedCandidate] = []
    for fv in req.candidate_factor_values:
        try:
            program = _db.materialize_gradient_program(fv, scheme, n_segments=req.n_segments)
        except (KeyError, NotImplementedError):
            continue
        peaks = _lss.simulate_chromatogram(
            lss, program, req.t0_min,
            plate_count=req.plate_count, t_dwell_min=req.t_dwell_min,
        )
        s = _scorer.score_chromatogram(
            peaks, rs_target=req.rs_target, runtime_target_min=req.runtime_target_min,
        )
        scored.append(RankedCandidate(
            factor_values=fv,
            simulated_crf=s["crf_total"],
            simulated_min_resolution=s["min_resolution"],
            simulated_runtime_min=s["runtime_min"],
            n_eluted=len(peaks),
        ))
    scored.sort(key=lambda c: c.simulated_crf, reverse=True)
    return SeedCandidatesLssOut(
        ranked=scored[: req.top_k],
        n_scored=len(scored),
        n_analytes=len(lss),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_chrom_method_optimizer.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
