"""mcp-xtb — GFN2-xTB semi-empirical geometry optimization and CREST conformer search (port 8010).

Tools:
- POST /optimize_geometry   — GFN2-xTB or GFN-FF single-point / geometry optimization
- POST /conformer_ensemble  — CREST conformer ensemble generation

Security:
- subprocess.run uses shell=False with an explicit arg list.
- SMILES validated via RDKit before invoking xTB.
- Subprocess timeout hard-capped at 120 s.
- Temporary directory cleaned up automatically.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Body
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-xtb")
settings = ToolSettings()

_XTB_TIMEOUT = 120  # seconds


def _xtb_available() -> bool:
    return shutil.which("xtb") is not None


app = create_app(
    name="mcp-xtb",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_xtb_available,
    required_scope="mcp_xtb:invoke",
)


# ---------------------------------------------------------------------------
# SMILES → XYZ via RDKit (before calling xtb)
# ---------------------------------------------------------------------------

def _smiles_to_xyz(smiles: str) -> str:
    """Convert a SMILES to 3-D XYZ block via RDKit ETKDG."""
    try:
        from rdkit import Chem  # type: ignore[import]  # noqa: PLC0415
        from rdkit.Chem import AllChem  # type: ignore[import]  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError("rdkit required inside the Docker image") from exc

    if not smiles or not smiles.strip():
        raise ValueError("smiles must be a non-empty string")
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"invalid SMILES: {smiles!r}")
    mol = Chem.AddHs(mol)
    if AllChem.EmbedMolecule(mol, AllChem.ETKDGv3()) == -1:
        raise ValueError(f"RDKit could not generate 3-D embedding for SMILES: {smiles!r}")
    AllChem.MMFFOptimizeMolecule(mol)

    conf = mol.GetConformer()
    lines = [str(mol.GetNumAtoms()), smiles]
    for atom in mol.GetAtoms():
        pos = conf.GetAtomPosition(atom.GetIdx())
        lines.append(f"{atom.GetSymbol():2s}  {pos.x:12.6f}  {pos.y:12.6f}  {pos.z:12.6f}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# subprocess helper
# ---------------------------------------------------------------------------

def _run_xtb(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    """Run xtb with shell=False for security."""
    return subprocess.run(  # noqa: S603
        args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=_XTB_TIMEOUT,
        shell=False,  # explicit — never shell=True
    )


def _parse_energy(stdout: str) -> float | None:
    """Extract total energy (Hartree) from xtb stdout.

    xtb prints lines like:
        TOTAL ENERGY          -5.123456789000 Eh
    so the numeric value is at index 2 (0-based).
    """
    for line in stdout.splitlines():
        if "TOTAL ENERGY" in line:
            parts = line.split()
            # Try index 2 first (canonical xtb format), fall back to -2.
            for idx in (2, -2):
                try:
                    return float(parts[idx])
                except (IndexError, ValueError):
                    pass
    return None


def _parse_gnorm(stdout: str) -> float | None:
    """Extract gradient norm from xtb stdout.

    xtb prints lines like:
        GRADIENT NORM          0.000234 Eh/a0
    so the numeric value is at index 2 (0-based).
    """
    for line in stdout.splitlines():
        if "GRADIENT NORM" in line:
            parts = line.split()
            for idx in (2, -2):
                try:
                    return float(parts[idx])
                except (IndexError, ValueError):
                    pass
    return None


# ---------------------------------------------------------------------------
# /optimize_geometry
# ---------------------------------------------------------------------------

class OptimizeGeometryIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=10_000)
    method: Literal["GFN2-xTB", "GFN-FF"] = "GFN2-xTB"


class OptimizeGeometryOut(BaseModel):
    optimized_xyz: str
    energy_hartree: float
    gnorm: float
    converged: bool


@app.post("/optimize_geometry", response_model=OptimizeGeometryOut, tags=["xtb"])
async def optimize_geometry(
    req: Annotated[OptimizeGeometryIn, Body(...)],
) -> OptimizeGeometryOut:
    xyz_block = _smiles_to_xyz(req.smiles)  # validates SMILES via RDKit

    gfn_flag = "--gfn2" if req.method == "GFN2-xTB" else "--gfnff"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        input_xyz = tmp_path / "mol.xyz"
        input_xyz.write_text(xyz_block)

        result = _run_xtb(
            ["xtb", "mol.xyz", gfn_flag, "--opt", "tight", "--json"],
            cwd=tmp_path,
        )
        if result.returncode != 0:
            raise ValueError(
                f"xtb optimization failed (exit {result.returncode}): {result.stderr[:500]}"
            )

        optimized_path = tmp_path / "xtbopt.xyz"
        if not optimized_path.exists():
            raise ValueError("xtb did not produce xtbopt.xyz")
        optimized_xyz = optimized_path.read_text()

    energy = _parse_energy(result.stdout)
    gnorm = _parse_gnorm(result.stdout)
    converged = "GEOMETRY CONVERGED" in result.stdout or "GEOMETRY OPTIMIZATION CONVERGED" in result.stdout

    return OptimizeGeometryOut(
        optimized_xyz=optimized_xyz,
        energy_hartree=energy if energy is not None else float("nan"),
        gnorm=gnorm if gnorm is not None else float("nan"),
        converged=converged,
    )


# ---------------------------------------------------------------------------
# /conformer_ensemble
# ---------------------------------------------------------------------------

_MAX_CONFORMERS = 100


class ConformerEntry(BaseModel):
    xyz: str
    energy_hartree: float
    weight: float = Field(ge=0.0, le=1.0)


class ConformerEnsembleIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=10_000)
    n_conformers: int = Field(default=20, ge=1, le=_MAX_CONFORMERS)


class ConformerEnsembleOut(BaseModel):
    conformers: list[ConformerEntry]


def _parse_crest_ensemble(ensemble_text: str) -> list[tuple[str, float]]:
    """Parse a multi-structure XYZ file from CREST into (xyz_block, energy) pairs."""
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


@app.post("/conformer_ensemble", response_model=ConformerEnsembleOut, tags=["xtb"])
async def conformer_ensemble(
    req: Annotated[ConformerEnsembleIn, Body(...)],
) -> ConformerEnsembleOut:
    xyz_block = _smiles_to_xyz(req.smiles)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        input_xyz = tmp_path / "mol.xyz"
        input_xyz.write_text(xyz_block)

        result = _run_xtb(
            ["crest", "mol.xyz", "--T", "4", "--niceprint"],
            cwd=tmp_path,
        )
        if result.returncode != 0:
            raise ValueError(
                f"crest failed (exit {result.returncode}): {result.stderr[:500]}"
            )

        ensemble_path = tmp_path / "crest_conformers.xyz"
        if not ensemble_path.exists():
            raise ValueError("crest did not produce crest_conformers.xyz")
        ensemble_text = ensemble_path.read_text()

    raw = _parse_crest_ensemble(ensemble_text)
    raw = raw[: req.n_conformers]

    # Boltzmann weights (relative, temperature-independent approximation).
    import math

    energies = [e for _, e in raw]
    e_min = min(energies) if energies else 0.0
    exp_vals = [math.exp(-(e - e_min) * 627.509) for e in energies]  # kcal/mol
    total = sum(exp_vals) or 1.0
    weights = [v / total for v in exp_vals]

    conformers = [
        ConformerEntry(xyz=xyz, energy_hartree=e, weight=w)
        for (xyz, e), w in zip(raw, weights)
    ]
    return ConformerEnsembleOut(conformers=conformers)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_xtb.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
