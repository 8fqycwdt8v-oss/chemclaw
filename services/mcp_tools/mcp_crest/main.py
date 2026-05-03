"""mcp-crest — CREST conformer / tautomer / protomer screening (port 8014).

Split out from mcp-xtb so CREST resource limits + image size are independent
of the xtb-only Phase 2 endpoints. Every result is cached through `qm_jobs`
keyed by the deterministic cache key (db/init/23_qm_results.sql).

Endpoints:
  POST /conformers — CREST conformer ensemble (replaces mcp-xtb's older one)
  POST /tautomers  — CREST -tautomerize (heuristic tautomer enumeration)
  POST /protomers  — CREST -protonate / -deprotonate

All endpoints accept the standard QmReqBase shape and return
{ job_id, cache_hit, ensemble: [{xyz, energy_hartree, weight}] }.
"""

from __future__ import annotations

import logging
import math
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Body
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.qm_cache_db import lookup as qm_lookup
from services.mcp_tools.common.qm_cache_db import store as qm_store
from services.mcp_tools.common.settings import ToolSettings


log = logging.getLogger("mcp-crest")
settings = ToolSettings()

_CREST_TIMEOUT = 600  # seconds; CREST can be slow on flexible molecules
_MAX_OUT_CONFORMERS = 200


def _crest_available() -> bool:
    return shutil.which("crest") is not None


app = create_app(
    name="mcp-crest",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_crest_available,
    required_scope="mcp_crest:invoke",
)


def _smiles_to_canonical_and_xyz(smiles: str) -> tuple[str, str, str | None]:
    try:
        from rdkit import Chem as _Chem  # noqa: PLC0415
        from rdkit.Chem import AllChem as _AllChem  # noqa: PLC0415
        from rdkit.Chem.inchi import MolToInchiKey as _ToInchiKey  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError("rdkit required inside the Docker image") from exc

    Chem: Any = _Chem
    AllChem: Any = _AllChem
    if not smiles or not smiles.strip():
        raise ValueError("smiles must be a non-empty string")
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"invalid SMILES: {smiles!r}")
    canonical = Chem.MolToSmiles(mol)
    try:
        inchikey = _ToInchiKey(mol) or None
    except Exception:  # noqa: BLE001
        inchikey = None
    mol = Chem.AddHs(mol)
    if AllChem.EmbedMolecule(mol, AllChem.ETKDGv3()) == -1:
        raise ValueError(f"RDKit could not embed SMILES: {smiles!r}")
    AllChem.MMFFOptimizeMolecule(mol)
    conf = mol.GetConformer()
    lines = [str(mol.GetNumAtoms()), canonical]
    for atom in mol.GetAtoms():
        pos = conf.GetAtomPosition(atom.GetIdx())
        lines.append(
            f"{atom.GetSymbol():2s}  {pos.x:12.6f}  {pos.y:12.6f}  {pos.z:12.6f}"
        )
    return canonical, "\n".join(lines), inchikey


def _run_crest(args: list[str], cwd: Path, timeout: int = _CREST_TIMEOUT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        args, cwd=str(cwd),
        capture_output=True, text=True,
        timeout=timeout, shell=False,
    )


def _parse_ensemble(text: str, max_n: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    lines = text.splitlines()
    i = idx = 0
    while i < len(lines) and idx < max_n:
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        try:
            n_atoms = int(line)
        except ValueError:
            i += 1
            continue
        if i + 1 + n_atoms >= len(lines):
            break
        comment = lines[i + 1]
        try:
            energy = float(comment.split()[0])
        except (IndexError, ValueError):
            energy = float("nan")
        block = "\n".join([line] + lines[i + 1: i + 2 + n_atoms])
        out.append({"ensemble_index": idx, "xyz": block, "energy_hartree": energy})
        idx += 1
        i += 2 + n_atoms
    return out


def _attach_boltzmann(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not entries:
        return entries
    energies = [e["energy_hartree"] for e in entries if math.isfinite(e["energy_hartree"])]
    e_min = min(energies) if energies else 0.0
    exp_vals = [
        math.exp(-(e["energy_hartree"] - e_min) * 627.509)
        if math.isfinite(e["energy_hartree"]) else 0.0
        for e in entries
    ]
    total = sum(exp_vals) or 1.0
    for entry, val in zip(entries, exp_vals):
        entry["boltzmann_weight"] = val / total
    return entries


# ---------------------------------------------------------------------------
# common shapes
# ---------------------------------------------------------------------------


class CrestReqBase(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    charge: int = 0
    multiplicity: int = Field(default=1, ge=1)
    method: Literal["GFN2", "GFN-FF"] = "GFN2"
    solvent_model: Literal["none", "alpb", "gbsa"] = "none"
    solvent_name: str | None = None
    threads: int = Field(default=4, ge=1, le=32)
    n_max: int = Field(default=20, ge=1, le=_MAX_OUT_CONFORMERS)
    force_recompute: bool = False


class EnsembleEntry(BaseModel):
    ensemble_index: int
    xyz: str
    energy_hartree: float
    boltzmann_weight: float


class EnsembleOut(BaseModel):
    job_id: str | None = None
    cache_hit: bool = False
    method: str = "CREST"
    task: str = ""
    ensemble: list[EnsembleEntry] = Field(default_factory=list)
    summary: str = ""


def _solvent_flags(model: str, name: str | None) -> list[str]:
    if model == "none" or not model:
        return []
    if not name:
        raise ValueError(f"solvent_model={model!r} requires solvent_name")
    if model == "alpb":
        return ["--alpb", name]
    if model == "gbsa":
        return ["--gbsa", name]
    raise ValueError(f"unsupported solvent_model: {model!r}")


def _level_flag(method: str) -> list[str]:
    return ["--gfn2"] if method == "GFN2" else ["--gfnff"]


# ---------------------------------------------------------------------------
# /conformers  /tautomers  /protomers
# ---------------------------------------------------------------------------


def _build_resp_from_cache(cached, task: str) -> EnsembleOut:
    return EnsembleOut(
        job_id=cached.job_id, cache_hit=True, method="CREST", task=task,
        summary=cached.summary_md or "cached",
        ensemble=[
            EnsembleEntry(
                ensemble_index=c["ensemble_index"], xyz=c["xyz"],
                energy_hartree=c["energy_hartree"] or 0.0,
                boltzmann_weight=float(c.get("boltzmann_weight", 0.0)),
            )
            for c in cached.conformers
        ],
    )


def _run_crest_task(req: CrestReqBase, task: str, extra_flags: list[str]) -> EnsembleOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)
    params = {"n_max": req.n_max}
    cached = None
    if not req.force_recompute:
        cached = qm_lookup(
            method="CREST", task=task, smiles_canonical=canonical,
            charge=req.charge, multiplicity=req.multiplicity,
            solvent_model=req.solvent_model, solvent_name=req.solvent_name,
            params=params,
        )
    if cached:
        return _build_resp_from_cache(cached, task)

    started = time.monotonic()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "mol.xyz").write_text(xyz)
        args = [
            "crest", "mol.xyz",
            *_level_flag(req.method),
            "--T", str(req.threads),
            *_solvent_flags(req.solvent_model, req.solvent_name),
            "--chrg", str(req.charge),
            "--uhf", str(req.multiplicity - 1),
            *extra_flags,
        ]
        result = _run_crest(args, tmp_path)
    if result.returncode != 0:
        raise ValueError(f"crest {task} failed: {result.stderr[:500]}")

    ensemble_files = {
        "conformers": "crest_conformers.xyz",
        "tautomers": "tautomers.xyz",
        "protomers": "protonated.xyz",
    }
    out_path = tmp_path / ensemble_files.get(task, "crest_conformers.xyz")
    if not out_path.exists():
        # Some CREST builds always write crest_conformers.xyz even for
        # tautomer / protomer modes — fall back to that.
        out_path = tmp_path / "crest_conformers.xyz"
    if not out_path.exists():
        raise ValueError(f"crest {task} did not produce expected ensemble file")
    entries = _attach_boltzmann(_parse_ensemble(out_path.read_text(), req.n_max))

    summary = f"CREST {task} on {canonical}: {len(entries)} structures"
    job_id = qm_store(
        method="CREST", task=task,
        smiles_canonical=canonical, inchikey=inchikey,
        charge=req.charge, multiplicity=req.multiplicity,
        solvent_model=req.solvent_model, solvent_name=req.solvent_name,
        params=params, summary_md=summary,
        conformers=entries,
        runtime_ms=int((time.monotonic() - started) * 1000),
    )
    return EnsembleOut(
        job_id=job_id, cache_hit=False, method="CREST", task=task,
        summary=summary,
        ensemble=[
            EnsembleEntry(
                ensemble_index=e["ensemble_index"], xyz=e["xyz"],
                energy_hartree=e["energy_hartree"],
                boltzmann_weight=e["boltzmann_weight"],
            )
            for e in entries
        ],
    )


@app.post("/conformers", response_model=EnsembleOut, tags=["crest"])
async def conformers(req: Annotated[CrestReqBase, Body(...)]) -> EnsembleOut:
    return _run_crest_task(req, task="conformers", extra_flags=["--niceprint"])


@app.post("/tautomers", response_model=EnsembleOut, tags=["crest"])
async def tautomers(req: Annotated[CrestReqBase, Body(...)]) -> EnsembleOut:
    return _run_crest_task(req, task="tautomers", extra_flags=["--tautomerize"])


@app.post("/protomers", response_model=EnsembleOut, tags=["crest"])
async def protomers(req: Annotated[CrestReqBase, Body(...)]) -> EnsembleOut:
    # `--protonate` enumerates protomers; `--deprotonate` enumerates the
    # conjugate-base forms. The route accepts a flag in `params`; default
    # `protonate` to mirror the most common pharmacology question.
    return _run_crest_task(req, task="protomers", extra_flags=["--protonate"])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_crest.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
