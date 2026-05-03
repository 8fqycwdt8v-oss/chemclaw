"""Shared helpers for mcp-xtb endpoints.

Extracted from main.py to keep route handlers focused on business logic.
Every helper here is pure (no module-level state) so route handlers can
be unit-tested in isolation.

Categories:
  * SMILES → XYZ via RDKit
  * subprocess wrapper for xtb / crest
  * stdout parsers (energy, gradient, HOMO/LUMO, thermo, fukui, scan log)
  * method / solvent CLI flag mapping
  * common Pydantic base models for request / response shapes
  * cache lookup wrapper used by every endpoint
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.qm_cache_db import QmJobLookup
from services.mcp_tools.common.qm_cache_db import lookup as qm_lookup


log = logging.getLogger("mcp-xtb")

XTB_TIMEOUT = 120
MAX_CONFORMERS = 100
MAX_MD_STEPS = 10_000
MAX_SCAN_POINTS = 200

QmMethod = Literal["GFN0", "GFN1", "GFN2", "GFN-FF", "g-xTB", "sTDA-xTB", "IPEA-xTB"]
SolventModel = Literal["none", "alpb", "gbsa", "cpcmx"]
ChargeScheme = Literal["mulliken", "cm5"]


# ---------------------------------------------------------------------------
# CLI flag mapping
# ---------------------------------------------------------------------------

_METHOD_FLAGS: dict[str, list[str]] = {
    "GFN0": ["--gfn", "0"],
    "GFN1": ["--gfn", "1"],
    "GFN2": ["--gfn", "2"],
    "GFN-FF": ["--gfnff"],
    "g-xTB": ["--gfn", "2", "--general"],  # placeholder; real g-xTB binary uses --gxtb
    "sTDA-xTB": ["--gfn", "2"],  # sTDA driven by --vfukui or --tda flag downstream
    "IPEA-xTB": ["--gfn", "2", "--ipea"],
}


def method_flags(method: str) -> list[str]:
    if method not in _METHOD_FLAGS:
        raise ValueError(f"unsupported method: {method!r}")
    return list(_METHOD_FLAGS[method])


def solvent_flags(model: str | None, name: str | None) -> list[str]:
    if not model or model == "none":
        return []
    if not name:
        raise ValueError(f"solvent_model={model!r} requires solvent_name")
    if model == "alpb":
        return ["--alpb", name]
    if model == "gbsa":
        return ["--gbsa", name]
    if model == "cpcmx":
        return ["--cpcmx", name]
    raise ValueError(f"unsupported solvent_model: {model!r}")


# ---------------------------------------------------------------------------
# SMILES → XYZ via RDKit
# ---------------------------------------------------------------------------

def smiles_to_canonical_and_xyz(smiles: str) -> tuple[str, str, str | None]:
    """Return (canonical_smiles, xyz_block, inchikey_or_None) from a SMILES string."""
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
        inchikey = _ToInchiKey(mol) or None  # type: ignore[no-untyped-call]
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


# ---------------------------------------------------------------------------
# subprocess
# ---------------------------------------------------------------------------

def run_xtb(args: list[str], cwd: Path, timeout: int = XTB_TIMEOUT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
        shell=False,
    )


def xtb_available() -> bool:
    return shutil.which("xtb") is not None


def stda_available() -> bool:
    return shutil.which("stda") is not None


# ---------------------------------------------------------------------------
# stdout parsers
# ---------------------------------------------------------------------------

def parse_energy(stdout: str) -> float | None:
    for line in stdout.splitlines():
        if "TOTAL ENERGY" in line:
            parts = line.split()
            for idx in (2, -2):
                try:
                    return float(parts[idx])
                except (IndexError, ValueError):
                    pass
    return None


def parse_gnorm(stdout: str) -> float | None:
    for line in stdout.splitlines():
        if "GRADIENT NORM" in line:
            parts = line.split()
            for idx in (2, -2):
                try:
                    return float(parts[idx])
                except (IndexError, ValueError):
                    pass
    return None


def parse_homo_lumo(stdout: str) -> tuple[float | None, float | None]:
    homo = lumo = None
    for line in stdout.splitlines():
        if "HOMO-LUMO GAP" in line:
            parts = line.split()
            for idx in range(len(parts) - 1):
                try:
                    val = float(parts[idx])
                    return val, None  # gap only
                except ValueError:
                    continue
        if "(HOMO)" in line:
            try:
                homo = float(line.split()[-2])
            except (IndexError, ValueError):
                pass
        if "(LUMO)" in line:
            try:
                lumo = float(line.split()[-2])
            except (IndexError, ValueError):
                pass
    return homo, lumo


def last_float(line: str) -> float | None:
    for tok in reversed(line.split()):
        try:
            return float(tok)
        except ValueError:
            continue
    return None


def parse_thermo(stdout: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for line in stdout.splitlines():
        s = line.strip()
        if "zero point energy" in s.lower():
            v = last_float(s)
            if v is not None:
                out["zpe_hartree"] = v
        elif "total enthalpy" in s.lower():
            v = last_float(s)
            if v is not None:
                out["h298"] = v
        elif "total free energy" in s.lower():
            v = last_float(s)
            if v is not None:
                out["g298"] = v
        elif "entropy" in s.lower() and "kcal" in s.lower():
            v = last_float(s)
            if v is not None:
                out["s298"] = v
    return out


def parse_fukui(stdout: str) -> tuple[list[float], list[float], list[float]]:
    fp: list[float] = []
    fm: list[float] = []
    fz: list[float] = []
    in_block = False
    for line in stdout.splitlines():
        if "Fukui index" in line:
            in_block = True
            continue
        if in_block:
            parts = line.split()
            if len(parts) < 4:
                if fp:
                    break
                continue
            try:
                fp.append(float(parts[1]))
                fm.append(float(parts[2]))
                fz.append(float(parts[3]))
            except (ValueError, IndexError):
                continue
    return fp, fm, fz


def parse_scan_log(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    points: list[dict[str, Any]] = []
    text = path.read_text().splitlines()
    idx = 0
    p_idx = 0
    while idx < len(text):
        line = text[idx].strip()
        if not line:
            idx += 1
            continue
        try:
            n_atoms = int(line)
        except ValueError:
            idx += 1
            continue
        if idx + 1 + n_atoms >= len(text):
            break
        comment = text[idx + 1]
        try:
            energy = float(comment.split()[1])
        except (IndexError, ValueError):
            energy = float("nan")
        xyz_lines = text[idx: idx + 2 + n_atoms]
        points.append({
            "point_index": p_idx,
            "coord_value": float("nan"),
            "energy": energy,
            "geometry_xyz": "\n".join(xyz_lines),
        })
        p_idx += 1
        idx += 2 + n_atoms
    return points


def parse_crest_ensemble(ensemble_text: str) -> list[tuple[str, float]]:
    conformers: list[tuple[str, float]] = []
    lines = ensemble_text.splitlines()
    i = 0
    while i < len(lines):
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
        except (ValueError, IndexError):
            energy = float("nan")
        xyz_lines = [line] + lines[i + 1: i + 2 + n_atoms]
        conformers.append(("\n".join(xyz_lines), energy))
        i += 2 + n_atoms
    return conformers


# ---------------------------------------------------------------------------
# Common Pydantic shapes shared by every QM endpoint
# ---------------------------------------------------------------------------


class QmReqBase(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    charge: int = 0
    multiplicity: int = Field(default=1, ge=1)
    method: QmMethod = "GFN2"
    solvent_model: SolventModel = "none"
    solvent_name: str | None = None
    force_recompute: bool = False


class QmRespBase(BaseModel):
    job_id: str | None = None
    cache_hit: bool = False
    status: str = "succeeded"
    summary: str = ""
    method: str = "GFN2"
    task: str = ""


def check_cache(
    *,
    method: str,
    task: str,
    smiles_canonical: str,
    charge: int,
    multiplicity: int,
    solvent_model: str | None,
    solvent_name: str | None,
    params: dict[str, Any] | None,
    force_recompute: bool,
) -> QmJobLookup | None:
    """Cache wrapper used by every QM endpoint.

    Returns the cached lookup or None when the caller should compute fresh.
    """
    if force_recompute:
        return None
    return qm_lookup(
        method=method,
        task=task,
        smiles_canonical=smiles_canonical,
        charge=charge,
        multiplicity=multiplicity,
        solvent_model=solvent_model,
        solvent_name=solvent_name,
        params=params,
    )
