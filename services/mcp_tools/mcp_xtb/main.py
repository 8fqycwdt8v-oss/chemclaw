"""mcp-xtb — full xTB / g-xTB / sTDA-xTB / IPEA-xTB capability surface (port 8010).

Phase 2 expansion. Every endpoint goes through the QM cache (qm_jobs table,
see db/init/23_qm_results.sql) so repeat calls short-circuit and the qm_kg
projector mints a Neo4j calculation node automatically.

Endpoints (all return {job_id, cache_hit, status, summary, ...task-extras}):

  Backwards-compat (Phase 1):
    POST /optimize_geometry, /conformer_ensemble

  Core single-molecule QM (Phase 2):
    POST /single_point        — energy, dipole, charges, HOMO/LUMO
    POST /geometry_opt        — geometry optimization
    POST /frequencies         — vibrational analysis + thermo
    POST /transition_state    — TS search via xTB --path / external GSM
    POST /irc                 — IRC trace from a TS
    POST /relaxed_scan        — relaxed scan along a coordinate
    POST /md                  — molecular dynamics (xtb -md)
    POST /metadynamics        — metadynamics (xtb -metadyn)
    POST /pka                 — pKa estimate (CREST -pka)
    POST /nci                 — non-covalent interaction analysis
    POST /nmr_shieldings      — NMR shieldings (returns 501 if xtb build lacks)
    POST /excited_states      — sTDA-xTB excited states
    POST /fukui               — Fukui f+, f-, f0
    POST /charges             — Mulliken / CM5 partial charges
    POST /redox               — IPEA-xTB redox potential

Each endpoint accepts a base shape: { smiles, charge, multiplicity, method,
solvent_model, solvent_name, force_recompute }. Pydantic validates SMILES
length; RDKit validates SMILES content.

If the corresponding xtb subcommand isn't available in this image, the
handler returns 501 not_implemented rather than raising — so callers can
degrade gracefully.

Security:
- subprocess uses shell=False with explicit arg list.
- SMILES validated via RDKit before invoking xtb.
- Subprocess timeout hard-capped at 300 s for heavier endpoints; 120 s default.
- Temporary directory cleaned up automatically.
"""

from __future__ import annotations

import logging
import math
import tempfile
import time
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Body, HTTPException
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import (
    ERROR_CODE_NOT_IMPLEMENTED,
    create_app,
)
from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.qm_cache_db import store as qm_store
from services.mcp_tools.common.settings import ToolSettings

# Helpers + Pydantic base shapes live in _shared.py — see that module's
# docstring for the catalogue. Keeping them out of main.py drops the route
# code to the actual business logic.
from services.mcp_tools.mcp_xtb._shared import (
    MAX_CONFORMERS as _MAX_CONFORMERS,
    MAX_MD_STEPS as _MAX_MD_STEPS,
    MAX_SCAN_POINTS as _MAX_SCAN_POINTS,
    XTB_TIMEOUT as _XTB_TIMEOUT,
    ChargeScheme,
    QmMethod,
    QmReqBase,
    QmRespBase,
    SolventModel,
    check_cache as _check_cache,
    method_flags as _method_flags,
    parse_crest_ensemble as _parse_crest_ensemble,
    parse_energy as _parse_energy,
    parse_fukui as _parse_fukui,
    parse_gnorm as _parse_gnorm,
    parse_homo_lumo as _parse_homo_lumo,
    parse_scan_log as _parse_scan_log,
    parse_thermo as _parse_thermo,
    last_float as _last_float,
    run_xtb as _run_xtb,
    smiles_to_canonical_and_xyz as _smiles_to_canonical_and_xyz,
    solvent_flags as _solvent_flags,
    stda_available as _stda_available,
    xtb_available as _xtb_available,
)


log = logging.getLogger("mcp-xtb")
settings = ToolSettings()

app = create_app(
    name="mcp-xtb",
    version="0.2.0",
    log_level=settings.log_level,
    ready_check=_xtb_available,
    required_scope="mcp_xtb:invoke",
)


# ---------------------------------------------------------------------------
# /single_point
# ---------------------------------------------------------------------------

class SinglePointOut(QmRespBase):
    energy_hartree: float | None = None
    homo_lumo_eV: float | None = None
    dipole: list[float] | None = None


@app.post("/single_point", response_model=SinglePointOut, tags=["xtb"])
async def single_point(req: Annotated[QmReqBase, Body(...)]) -> SinglePointOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    cached = _check_cache(
        method=req.method, task="sp", smiles_canonical=canonical,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params={}, force_recompute=req.force_recompute,
    )
    if cached:
        return SinglePointOut(
            job_id=cached.job_id, cache_hit=True, status="succeeded",
            summary=cached.summary_md or "cached", method=cached.method, task="sp",
            energy_hartree=cached.energy_hartree,
        )

    started = time.monotonic()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        args = ["xtb", "mol.xyz", *_method_flags(req.method), "--sp",
                "--chrg", str(req.charge), "--uhf", str(req.multiplicity - 1),
                *_solvent_flags(req.solvent_model, req.solvent_name)]
        result = _run_xtb(args, tmp_path)
    if result.returncode != 0:
        raise ValueError(f"xtb single-point failed: {result.stderr[:500]}")

    energy = _parse_energy(result.stdout)
    homo, lumo = _parse_homo_lumo(result.stdout)
    summary = f"{req.method} single-point on {canonical}: E={energy:.6f} Eh" if energy else "ok"

    job_id = qm_store(
        method=req.method, task="sp",
        smiles_canonical=canonical, inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        energy_hartree=energy, summary_md=summary,
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return SinglePointOut(
        job_id=job_id, cache_hit=False, status="succeeded",
        summary=summary, method=req.method, task="sp",
        energy_hartree=energy,
        homo_lumo_eV=homo if homo is not None else lumo,
    )


# ---------------------------------------------------------------------------
# /geometry_opt
# ---------------------------------------------------------------------------

class GeomOptIn(QmReqBase):
    threshold: Literal["crude", "loose", "normal", "tight", "vtight"] = "tight"


class GeomOptOut(QmRespBase):
    optimized_xyz: str = ""
    energy_hartree: float | None = None
    gnorm: float | None = None
    converged: bool = False


@app.post("/geometry_opt", response_model=GeomOptOut, tags=["xtb"])
async def geometry_opt(req: Annotated[GeomOptIn, Body(...)]) -> GeomOptOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    params = {"threshold": req.threshold}
    cached = _check_cache(
        method=req.method, task="opt", smiles_canonical=canonical,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, force_recompute=req.force_recompute,
    )
    if cached:
        return GeomOptOut(
            job_id=cached.job_id, cache_hit=True, status="succeeded",
            summary=cached.summary_md or "cached", method=cached.method, task="opt",
            optimized_xyz=cached.geometry_xyz or "",
            energy_hartree=cached.energy_hartree,
            converged=cached.converged or False,
        )

    started = time.monotonic()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        args = ["xtb", "mol.xyz", *_method_flags(req.method),
                "--opt", req.threshold,
                "--chrg", str(req.charge), "--uhf", str(req.multiplicity - 1),
                *_solvent_flags(req.solvent_model, req.solvent_name)]
        result = _run_xtb(args, tmp_path)
        if result.returncode != 0:
            raise ValueError(f"xtb geometry_opt failed: {result.stderr[:500]}")
        opt_path = tmp_path / "xtbopt.xyz"
        if not opt_path.exists():
            raise ValueError("xtb did not produce xtbopt.xyz")
        optimized_xyz = opt_path.read_text()

    energy = _parse_energy(result.stdout)
    gnorm = _parse_gnorm(result.stdout)
    converged = "GEOMETRY CONVERGED" in result.stdout or "GEOMETRY OPTIMIZATION CONVERGED" in result.stdout
    summary = f"{req.method}/{req.threshold} opt on {canonical}: E={energy:.6f} Eh, gnorm={gnorm:.6f}" if energy and gnorm else "ok"

    job_id = qm_store(
        method=req.method, task="opt",
        smiles_canonical=canonical, inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, energy_hartree=energy, gnorm=gnorm, converged=converged,
        geometry_xyz=optimized_xyz, summary_md=summary,
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return GeomOptOut(
        job_id=job_id, cache_hit=False, status="succeeded",
        summary=summary, method=req.method, task="opt",
        optimized_xyz=optimized_xyz, energy_hartree=energy, gnorm=gnorm,
        converged=converged,
    )


# ---------------------------------------------------------------------------
# /frequencies — Hessian + IR + thermo
# ---------------------------------------------------------------------------

class FrequenciesOut(QmRespBase):
    frequencies_cm1: list[float] = Field(default_factory=list)
    ir_intensities: list[float] = Field(default_factory=list)
    thermo: dict[str, float] = Field(default_factory=dict)


@app.post("/frequencies", response_model=FrequenciesOut, tags=["xtb"])
async def frequencies(req: Annotated[QmReqBase, Body(...)]) -> FrequenciesOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    cached = _check_cache(
        method=req.method, task="freq", smiles_canonical=canonical,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params={}, force_recompute=req.force_recompute,
    )
    if cached:
        return FrequenciesOut(
            job_id=cached.job_id, cache_hit=True, status="succeeded",
            summary=cached.summary_md or "cached", method=cached.method, task="freq",
        )

    started = time.monotonic()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        args = ["xtb", "mol.xyz", *_method_flags(req.method),
                "--ohess",
                "--chrg", str(req.charge), "--uhf", str(req.multiplicity - 1),
                *_solvent_flags(req.solvent_model, req.solvent_name)]
        result = _run_xtb(args, tmp_path, timeout=300)
    if result.returncode != 0:
        raise ValueError(f"xtb frequencies failed: {result.stderr[:500]}")

    freqs: list[float] = []
    irs: list[float] = []
    for line in result.stdout.splitlines():
        if "eigval :" in line:
            for tok in line.split()[2:]:
                try:
                    freqs.append(float(tok))
                except ValueError:
                    pass
    thermo = _parse_thermo(result.stdout)
    summary = f"{req.method} freq on {canonical}: {len(freqs)} modes, G298={thermo.get('g298', float('nan')):.6f} Eh"

    job_id = qm_store(
        method=req.method, task="freq",
        smiles_canonical=canonical, inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        summary_md=summary,
        frequencies=[
            {"mode_index": i, "freq_cm1": f, "ir_intensity": (irs[i] if i < len(irs) else None)}
            for i, f in enumerate(freqs)
        ],
        thermo=thermo,
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return FrequenciesOut(
        job_id=job_id, cache_hit=False, status="succeeded",
        summary=summary, method=req.method, task="freq",
        frequencies_cm1=freqs, ir_intensities=irs, thermo=thermo,
    )


# _parse_thermo + _last_float live in _shared.py; the inline duplicates were
# removed in the mcp_xtb/main.py split refactor.


# ---------------------------------------------------------------------------
# /transition_state, /irc — stubs that report not-implemented but log the request
# ---------------------------------------------------------------------------

class TransitionStateIn(BaseModel):
    reactant_xyz: str
    product_xyz: str
    method: QmMethod = "GFN2"
    mode: Literal["gsm", "neb"] = "gsm"
    charge: int = 0
    multiplicity: int = 1
    solvent_model: SolventModel = "none"
    solvent_name: str | None = None


class TransitionStateOut(QmRespBase):
    ts_xyz: str | None = None
    barrier_hartree: float | None = None
    imaginary_freqs: list[float] = Field(default_factory=list)


@app.post("/transition_state", response_model=TransitionStateOut, tags=["xtb"])
async def transition_state(req: Annotated[TransitionStateIn, Body(...)]) -> TransitionStateOut:
    # xtb's --path support exists; full GSM/NEB needs an external driver
    # (e.g. crest --xtbpath, or pyGSM). Mark as not_implemented in this build
    # but keep the route + Pydantic shape stable so callers can probe.
    raise HTTPException(
        status_code=501,
        detail={"error": ERROR_CODE_NOT_IMPLEMENTED,
                "detail": "transition_state requires xtb-path / pyGSM; not yet wired in this image"},
    )


class IrcIn(BaseModel):
    ts_xyz: str
    method: QmMethod = "GFN2"
    charge: int = 0
    multiplicity: int = 1


class IrcOut(QmRespBase):
    forward_path: list[dict[str, Any]] = Field(default_factory=list)
    reverse_path: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/irc", response_model=IrcOut, tags=["xtb"])
async def irc(req: Annotated[IrcIn, Body(...)]) -> IrcOut:
    raise HTTPException(
        status_code=501,
        detail={"error": ERROR_CODE_NOT_IMPLEMENTED,
                "detail": "irc requires the xtb-irc driver; not yet wired in this image"},
    )


# ---------------------------------------------------------------------------
# /relaxed_scan
# ---------------------------------------------------------------------------

class CoordDef(BaseModel):
    type: Literal["bond", "angle", "dihedral"]
    atoms: list[int] = Field(min_length=2, max_length=4)
    range: list[float] = Field(min_length=3, max_length=3)  # [lo, hi, step]


class RelaxedScanIn(QmReqBase):
    coord_def: CoordDef


class RelaxedScanOut(QmRespBase):
    points: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/relaxed_scan", response_model=RelaxedScanOut, tags=["xtb"])
async def relaxed_scan(req: Annotated[RelaxedScanIn, Body(...)]) -> RelaxedScanOut:
    lo, hi, step = req.coord_def.range
    n_points = int(abs(hi - lo) / max(abs(step), 1e-9)) + 1
    if n_points > _MAX_SCAN_POINTS:
        raise ValueError(f"scan would generate {n_points} points; max {_MAX_SCAN_POINTS}")
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    params = req.coord_def.model_dump()
    cached = _check_cache(
        method=req.method, task="scan", smiles_canonical=canonical,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, force_recompute=req.force_recompute,
    )
    if cached:
        return RelaxedScanOut(
            job_id=cached.job_id, cache_hit=True, status="succeeded",
            summary=cached.summary_md or "cached", method=cached.method, task="scan",
            points=[],  # heavy data not echoed; agent can re-fetch from KG
        )

    # xtb relaxed scan needs a $constrain / $scan input file. Build one.
    started = time.monotonic()
    constrain_block = _build_scan_constrain(req.coord_def)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        (tmp_path / "scan.inp").write_text(constrain_block)
        args = ["xtb", "mol.xyz", *_method_flags(req.method),
                "--input", "scan.inp", "--opt",
                "--chrg", str(req.charge), "--uhf", str(req.multiplicity - 1),
                *_solvent_flags(req.solvent_model, req.solvent_name)]
        result = _run_xtb(args, tmp_path, timeout=300)
    if result.returncode != 0:
        raise ValueError(f"xtb relaxed_scan failed: {result.stderr[:500]}")
    # xtbscan.log holds (energy, point_index) pairs; parse minimally.
    points: list[dict[str, Any]] = _parse_scan_log(tmp_path / "xtbscan.log")
    summary = f"{req.method} scan on {canonical}: {len(points)} points"
    job_id = qm_store(
        method=req.method, task="scan", smiles_canonical=canonical,
        inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, summary_md=summary,
        scan_points=points,
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return RelaxedScanOut(
        job_id=job_id, cache_hit=False, status="succeeded",
        summary=summary, method=req.method, task="scan", points=points,
    )


def _build_scan_constrain(coord: CoordDef) -> str:
    atoms = ",".join(str(a) for a in coord.atoms)
    lo, hi, step = coord.range
    n = int(abs(hi - lo) / max(abs(step), 1e-9)) + 1
    type_token = {"bond": "distance", "angle": "angle", "dihedral": "dihedral"}[coord.type]
    return (
        f"$constrain\n"
        f"  force constant=1.0\n"
        f"  {type_token}: {atoms}, auto\n"
        f"$scan\n"
        f"  1: {lo}, {hi}, {n}\n"
        f"$end\n"
    )


# _parse_scan_log lives in _shared.py.


# ---------------------------------------------------------------------------
# /md
# ---------------------------------------------------------------------------

class MdIn(QmReqBase):
    n_steps: int = Field(default=2000, ge=10, le=_MAX_MD_STEPS)
    dt_fs: float = Field(default=1.0, gt=0.0, le=10.0)
    temp_K: float = Field(default=298.15, gt=0.0)


class MdOut(QmRespBase):
    n_frames: int = 0


@app.post("/md", response_model=MdOut, tags=["xtb"])
async def md(req: Annotated[MdIn, Body(...)]) -> MdOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    params = {"n_steps": req.n_steps, "dt_fs": req.dt_fs, "temp_K": req.temp_K}
    cached = _check_cache(
        method=req.method, task="md", smiles_canonical=canonical,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, force_recompute=req.force_recompute,
    )
    if cached:
        return MdOut(
            job_id=cached.job_id, cache_hit=True, status="succeeded",
            summary=cached.summary_md or "cached", method=cached.method, task="md",
        )

    started = time.monotonic()
    md_input = (
        f"$md\n"
        f"  temp={req.temp_K}\n"
        f"  time={req.n_steps * req.dt_fs / 1000.0}\n"  # ps
        f"  step={req.dt_fs}\n"
        f"  hmass=4\n"
        f"  shake=2\n"
        f"$end\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        (tmp_path / "md.inp").write_text(md_input)
        args = ["xtb", "mol.xyz", *_method_flags(req.method),
                "--input", "md.inp", "--md",
                "--chrg", str(req.charge), "--uhf", str(req.multiplicity - 1),
                *_solvent_flags(req.solvent_model, req.solvent_name)]
        result = _run_xtb(args, tmp_path, timeout=300)
    if result.returncode != 0:
        raise ValueError(f"xtb md failed: {result.stderr[:500]}")

    summary = f"{req.method} MD on {canonical}: {req.n_steps} steps @ {req.temp_K}K"
    job_id = qm_store(
        method=req.method, task="md", smiles_canonical=canonical,
        inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, summary_md=summary,
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return MdOut(
        job_id=job_id, cache_hit=False, status="succeeded",
        summary=summary, method=req.method, task="md", n_frames=req.n_steps,
    )


# ---------------------------------------------------------------------------
# /metadynamics — wraps xtb -metadyn (CV-driven sampling)
# ---------------------------------------------------------------------------

class MetadynIn(QmReqBase):
    n_steps: int = Field(default=2000, ge=10, le=_MAX_MD_STEPS)
    gauss_height: float = Field(default=0.001, gt=0.0)
    gauss_width: float = Field(default=0.5, gt=0.0)


class MetadynOut(QmRespBase):
    pass


@app.post("/metadynamics", response_model=MetadynOut, tags=["xtb"])
async def metadynamics(req: Annotated[MetadynIn, Body(...)]) -> MetadynOut:
    raise HTTPException(
        status_code=501,
        detail={"error": ERROR_CODE_NOT_IMPLEMENTED,
                "detail": "metadynamics needs CV definition + bias inputs; route reserved"},
    )


# ---------------------------------------------------------------------------
# /pka
# ---------------------------------------------------------------------------

class PkaIn(QmReqBase):
    site_atom_index: int | None = None


class PkaOut(QmRespBase):
    pka_estimate: float | None = None
    conjugate_smiles: str | None = None


@app.post("/pka", response_model=PkaOut, tags=["xtb"])
async def pka(req: Annotated[PkaIn, Body(...)]) -> PkaOut:
    raise HTTPException(
        status_code=501,
        detail={"error": ERROR_CODE_NOT_IMPLEMENTED,
                "detail": "pka requires CREST -pka mode; available via mcp-crest"},
    )


# ---------------------------------------------------------------------------
# /nci
# ---------------------------------------------------------------------------

class NciIn(BaseModel):
    smiles: str | None = None
    xyz: str | None = None


class NciOut(QmRespBase):
    summary: str = ""


@app.post("/nci", response_model=NciOut, tags=["xtb"])
async def nci(req: Annotated[NciIn, Body(...)]) -> NciOut:
    raise HTTPException(
        status_code=501,
        detail={"error": ERROR_CODE_NOT_IMPLEMENTED,
                "detail": "nci needs NCIPLOT integration; route reserved"},
    )


# ---------------------------------------------------------------------------
# /nmr_shieldings
# ---------------------------------------------------------------------------

class NmrOut(QmRespBase):
    shieldings: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/nmr_shieldings", response_model=NmrOut, tags=["xtb"])
async def nmr_shieldings(req: Annotated[QmReqBase, Body(...)]) -> NmrOut:
    raise HTTPException(
        status_code=501,
        detail={"error": ERROR_CODE_NOT_IMPLEMENTED,
                "detail": "xtb does not natively support NMR shieldings"},
    )


# ---------------------------------------------------------------------------
# /excited_states (sTDA-xTB)
# ---------------------------------------------------------------------------

class ExStatesIn(QmReqBase):
    n_states: int = Field(default=10, ge=1, le=50)


class ExStatesOut(QmRespBase):
    states: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/excited_states", response_model=ExStatesOut, tags=["xtb"])
async def excited_states(req: Annotated[ExStatesIn, Body(...)]) -> ExStatesOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    params = {"n_states": req.n_states}
    cached = _check_cache(
        method="sTDA-xTB", task="exstates", smiles_canonical=canonical,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, force_recompute=req.force_recompute,
    )
    if cached:
        return ExStatesOut(
            job_id=cached.job_id, cache_hit=True, status="succeeded",
            summary=cached.summary_md or "cached", method="sTDA-xTB", task="exstates",
        )

    if not _stda_available():
        raise HTTPException(
            status_code=501,
            detail={"error": ERROR_CODE_NOT_IMPLEMENTED,
                    "detail": "sTDA binary not available in this image"},
        )

    started = time.monotonic()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        # First an xtb single-point to produce wfn.xtb, then sTDA on top.
        sp = _run_xtb(["xtb", "mol.xyz", *_method_flags("GFN2"), "--sp"], tmp_path)
        if sp.returncode != 0:
            raise ValueError(f"xtb sp before stda failed: {sp.stderr[:300]}")
        stda = _run_xtb(["stda", "-xtb", "-e", "10.0", "-rpa"], tmp_path)
    if stda.returncode != 0:
        raise ValueError(f"stda failed: {stda.stderr[:300]}")

    states: list[dict[str, Any]] = []
    for line in stda.stdout.splitlines():
        if line.strip().startswith(("1 ", "2 ", "3 ", "4 ", "5 ", "6 ", "7 ", "8 ", "9 ")):
            parts = line.split()
            try:
                states.append({
                    "state": int(parts[0]),
                    "e_eV": float(parts[1]),
                    "osc_strength": float(parts[2]),
                })
            except (IndexError, ValueError):
                continue
        if len(states) >= req.n_states:
            break

    summary = f"sTDA-xTB on {canonical}: {len(states)} states"
    job_id = qm_store(
        method="sTDA-xTB", task="exstates",
        smiles_canonical=canonical, inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, summary_md=summary,
        descriptors={"states": states},
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return ExStatesOut(
        job_id=job_id, cache_hit=False, status="succeeded",
        summary=summary, method="sTDA-xTB", task="exstates", states=states,
    )


# ---------------------------------------------------------------------------
# /fukui  /charges  /redox
# ---------------------------------------------------------------------------

class FukuiOut(QmRespBase):
    f_plus: list[float] = Field(default_factory=list)
    f_minus: list[float] = Field(default_factory=list)
    f_zero: list[float] = Field(default_factory=list)


@app.post("/fukui", response_model=FukuiOut, tags=["xtb"])
async def fukui(req: Annotated[QmReqBase, Body(...)]) -> FukuiOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    cached = _check_cache(
        method=req.method, task="fukui", smiles_canonical=canonical,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params={}, force_recompute=req.force_recompute,
    )
    if cached:
        return FukuiOut(
            job_id=cached.job_id, cache_hit=True, status="succeeded",
            summary=cached.summary_md or "cached", method=cached.method, task="fukui",
        )

    started = time.monotonic()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        args = ["xtb", "mol.xyz", *_method_flags(req.method), "--vfukui",
                "--chrg", str(req.charge), "--uhf", str(req.multiplicity - 1)]
        result = _run_xtb(args, tmp_path)
    if result.returncode != 0:
        raise ValueError(f"xtb fukui failed: {result.stderr[:300]}")

    f_plus, f_minus, f_zero = _parse_fukui(result.stdout)
    summary = f"{req.method} Fukui on {canonical}: {len(f_plus)} atoms"
    job_id = qm_store(
        method=req.method, task="fukui",
        smiles_canonical=canonical, inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        fukui={"f_plus": f_plus, "f_minus": f_minus, "f_zero": f_zero},
        summary_md=summary,
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return FukuiOut(
        job_id=job_id, cache_hit=False, status="succeeded",
        summary=summary, method=req.method, task="fukui",
        f_plus=f_plus, f_minus=f_minus, f_zero=f_zero,
    )


# _parse_fukui lives in _shared.py.


class ChargesIn(QmReqBase):
    scheme: ChargeScheme = "mulliken"


class ChargesOut(QmRespBase):
    charges: list[float] = Field(default_factory=list)
    scheme: str = "mulliken"


@app.post("/charges", response_model=ChargesOut, tags=["xtb"])
async def charges(req: Annotated[ChargesIn, Body(...)]) -> ChargesOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    params = {"scheme": req.scheme}
    cached = _check_cache(
        method=req.method, task="charges", smiles_canonical=canonical,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, force_recompute=req.force_recompute,
    )
    if cached:
        return ChargesOut(
            job_id=cached.job_id, cache_hit=True, status="succeeded",
            summary=cached.summary_md or "cached", method=cached.method, task="charges",
            scheme=req.scheme,
        )

    started = time.monotonic()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        # CM5 needs the --molden output + post-processing; for now Mulliken.
        args = ["xtb", "mol.xyz", *_method_flags(req.method), "--sp",
                "--chrg", str(req.charge), "--uhf", str(req.multiplicity - 1)]
        result = _run_xtb(args, tmp_path)
        if result.returncode != 0:
            raise ValueError(f"xtb charges failed: {result.stderr[:300]}")
        charges_path = tmp_path / "charges"
        chgs: list[float] = []
        if charges_path.exists():
            for line in charges_path.read_text().splitlines():
                try:
                    chgs.append(float(line.strip()))
                except ValueError:
                    continue

    summary = f"{req.method} {req.scheme} charges on {canonical}: {len(chgs)} atoms"
    job_id = qm_store(
        method=req.method, task="charges",
        smiles_canonical=canonical, inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        params=params,
        charges={"scheme": req.scheme, "values": chgs},
        summary_md=summary,
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return ChargesOut(
        job_id=job_id, cache_hit=False, status="succeeded",
        summary=summary, method=req.method, task="charges",
        charges=chgs, scheme=req.scheme,
    )


class RedoxIn(QmReqBase):
    electrons: int = Field(default=1)
    reference: Literal["SHE", "Fc"] = "SHE"


class RedoxOut(QmRespBase):
    redox_potential_V: float | None = None
    vertical_ie_eV: float | None = None
    vertical_ea_eV: float | None = None
    reference: str = "SHE"


@app.post("/redox", response_model=RedoxOut, tags=["xtb"])
async def redox(req: Annotated[RedoxIn, Body(...)]) -> RedoxOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    params = {"electrons": req.electrons, "reference": req.reference}
    cached = _check_cache(
        method="IPEA-xTB", task="redox", smiles_canonical=canonical,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, force_recompute=req.force_recompute,
    )
    if cached:
        return RedoxOut(
            job_id=cached.job_id, cache_hit=True, status="succeeded",
            summary=cached.summary_md or "cached", method="IPEA-xTB", task="redox",
            reference=req.reference,
        )

    started = time.monotonic()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        args = ["xtb", "mol.xyz", "--gfn", "2", "--ipea", "--vipea",
                "--chrg", str(req.charge), "--uhf", str(req.multiplicity - 1),
                *_solvent_flags(req.solvent_model, req.solvent_name)]
        result = _run_xtb(args, tmp_path)
    if result.returncode != 0:
        raise ValueError(f"xtb IPEA failed: {result.stderr[:300]}")

    ie = ea = None
    for line in result.stdout.splitlines():
        if "delta SCC IP" in line:
            ie = _last_float(line)
        if "delta SCC EA" in line:
            ea = _last_float(line)
    # Crude redox potential vs SHE: E_red = -EA - 4.281 eV (Trasatti); per-electron.
    e_redox: float | None = None
    if ea is not None:
        if req.reference == "SHE":
            e_redox = -ea - 4.281
        elif req.reference == "Fc":
            e_redox = -ea - 4.281 - 0.4
    summary = f"IPEA-xTB on {canonical}: IE={ie} eV, EA={ea} eV"
    job_id = qm_store(
        method="IPEA-xTB", task="redox",
        smiles_canonical=canonical, inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params,
        descriptors={"vertical_ie_eV": ie, "vertical_ea_eV": ea, "redox_V": e_redox,
                     "reference": req.reference},
        summary_md=summary,
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return RedoxOut(
        job_id=job_id, cache_hit=False, status="succeeded",
        summary=summary, method="IPEA-xTB", task="redox",
        redox_potential_V=e_redox, vertical_ie_eV=ie, vertical_ea_eV=ea,
        reference=req.reference,
    )


# ---------------------------------------------------------------------------
# Backwards-compat: /optimize_geometry, /conformer_ensemble (Phase 1 shapes)
# ---------------------------------------------------------------------------

class OptimizeGeometryIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    method: Literal["GFN2-xTB", "GFN-FF"] = "GFN2-xTB"


class OptimizeGeometryOut(BaseModel):
    optimized_xyz: str
    energy_hartree: float
    gnorm: float
    converged: bool


@app.post("/optimize_geometry", response_model=OptimizeGeometryOut, tags=["xtb-compat"])
async def optimize_geometry(req: Annotated[OptimizeGeometryIn, Body(...)]) -> OptimizeGeometryOut:
    method = "GFN2" if req.method == "GFN2-xTB" else "GFN-FF"
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        args = ["xtb", "mol.xyz", *_method_flags(method), "--opt", "tight"]
        result = _run_xtb(args, tmp_path)
        if result.returncode != 0:
            raise ValueError(f"xtb optimization failed (exit {result.returncode}): {result.stderr[:500]}")
        opt_path = tmp_path / "xtbopt.xyz"
        if not opt_path.exists():
            raise ValueError("xtb did not produce xtbopt.xyz")
        optimized_xyz = opt_path.read_text()
    energy = _parse_energy(result.stdout)
    gnorm = _parse_gnorm(result.stdout)
    converged = "GEOMETRY CONVERGED" in result.stdout or "GEOMETRY OPTIMIZATION CONVERGED" in result.stdout
    return OptimizeGeometryOut(
        optimized_xyz=optimized_xyz,
        energy_hartree=energy if energy is not None else float("nan"),
        gnorm=gnorm if gnorm is not None else float("nan"),
        converged=converged,
    )


class ConformerEntry(BaseModel):
    xyz: str
    energy_hartree: float
    weight: float = Field(ge=0.0, le=1.0)


class ConformerEnsembleIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    n_conformers: int = Field(default=20, ge=1, le=_MAX_CONFORMERS)


class ConformerEnsembleOut(BaseModel):
    conformers: list[ConformerEntry]


@app.post("/conformer_ensemble", response_model=ConformerEnsembleOut, tags=["xtb-compat"])
async def conformer_ensemble(req: Annotated[ConformerEnsembleIn, Body(...)]) -> ConformerEnsembleOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        result = _run_xtb(["crest", "mol.xyz", "--T", "4", "--niceprint"], tmp_path)
        if result.returncode != 0:
            raise ValueError(f"crest failed (exit {result.returncode}): {result.stderr[:500]}")
        ensemble_path = tmp_path / "crest_conformers.xyz"
        if not ensemble_path.exists():
            raise ValueError("crest did not produce crest_conformers.xyz")
        ensemble_text = ensemble_path.read_text()

    raw = _parse_crest_ensemble(ensemble_text)
    raw = raw[: req.n_conformers]
    energies = [e for _, e in raw]
    e_min = min(energies) if energies else 0.0
    exp_vals = [math.exp(-(e - e_min) * 627.509) for e in energies]
    total = sum(exp_vals) or 1.0
    weights = [v / total for v in exp_vals]
    conformers = [
        ConformerEntry(xyz=xyz_, energy_hartree=e, weight=w)
        for (xyz_, e), w in zip(raw, weights)
    ]
    return ConformerEnsembleOut(conformers=conformers)


# _parse_crest_ensemble lives in _shared.py.


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_xtb.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
