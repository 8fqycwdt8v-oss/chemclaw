"""mcp-xtb — GFN2-xTB semi-empirical geometry optimization and CREST conformer search (port 8010).

Tools:
- POST /optimize_geometry   — GFN2-xTB or GFN-FF single-point / geometry optimization (atomic)
- POST /conformer_ensemble  — CREST conformer ensemble + per-conformer optimisation (engine-routed)
- POST /run_workflow        — run a named multi-step recipe (see ``recipes/``)

Security:
- subprocess.run uses shell=False with an explicit arg list.
- SMILES validated via RDKit before invoking xTB.
- Subprocess timeout hard-capped at 120 s for the legacy atomic path,
  per-step + per-workflow caps for the engine-routed paths.
- Temporary directory cleaned up automatically.
"""

from __future__ import annotations

import functools
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Body
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings
from services.mcp_tools.mcp_xtb import workflow

log = logging.getLogger("mcp-xtb")
settings = ToolSettings()

_XTB_TIMEOUT = 120  # seconds — legacy /optimize_geometry path

# Engine-routed paths read these from env vars; admin-friendly migration
# to ``config_settings`` is a follow-up (mcp-xtb does not currently
# carry a Postgres dependency).
_DEFAULT_STEP_TIMEOUT_S = 120
_DEFAULT_WORKFLOW_TIMEOUT_S = 600
_HARD_WORKFLOW_TIMEOUT_CEILING_S = 1800


# Env vars are read once per process; tests that want to flip them call
# ``_step_timeout_s.cache_clear()`` / ``_workflow_timeout_default_s.cache_clear()``.
@functools.lru_cache(maxsize=1)
def _step_timeout_s() -> int:
    raw = os.environ.get("MCP_XTB_STEP_TIMEOUT_SECONDS")
    try:
        return int(raw) if raw else _DEFAULT_STEP_TIMEOUT_S
    except ValueError:
        return _DEFAULT_STEP_TIMEOUT_S


@functools.lru_cache(maxsize=1)
def _workflow_timeout_default_s() -> int:
    raw = os.environ.get("MCP_XTB_WORKFLOW_TIMEOUT_SECONDS")
    try:
        return int(raw) if raw else _DEFAULT_WORKFLOW_TIMEOUT_S
    except ValueError:
        return _DEFAULT_WORKFLOW_TIMEOUT_S


def _workflow_timeout_s(requested: int | None) -> int:
    if requested is not None:
        return min(max(1, requested), _HARD_WORKFLOW_TIMEOUT_CEILING_S)
    return min(max(1, _workflow_timeout_default_s()), _HARD_WORKFLOW_TIMEOUT_CEILING_S)


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
    """Convert a SMILES to 3-D XYZ block via RDKit ETKDG.

    rdkit ships no stubs, so we keep the imports and module objects
    typed as Any. Each call through Chem/AllChem is then duck-typed
    rather than flagged by mypy strict mode.
    """
    try:
        from rdkit import Chem as _Chem  # noqa: PLC0415
        from rdkit.Chem import AllChem as _AllChem  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError("rdkit required inside the Docker image") from exc

    Chem: Any = _Chem
    AllChem: Any = _AllChem

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

def _run_xtb(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
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
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
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
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
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
    """Boltzmann-weighted CREST ensemble (engine-routed since the
    workflow refactor: each conformer is xtb-optimised before weighting).
    """
    from services.mcp_tools.mcp_xtb.recipes import RECIPES

    result = await workflow.run(
        RECIPES["optimize_ensemble"],
        {"smiles": req.smiles, "n_conformers": req.n_conformers},
        total_timeout_s=_workflow_timeout_s(None),
        step_timeout_s=_step_timeout_s(),
    )
    if not result.success:
        failed = next((s for s in result.steps if not s.ok), None)
        raise ValueError(
            f"conformer_ensemble failed at step "
            f"{failed.name if failed else '?'}: "
            f"{failed.error if failed else 'unknown'}",
        )
    return ConformerEnsembleOut(
        conformers=[ConformerEntry(**c) for c in result.outputs["conformers"]],
    )


# ---------------------------------------------------------------------------
# /run_workflow — generic multi-step xtb recipe runner
# ---------------------------------------------------------------------------

# Cap the number of top-level keys in a recipe inputs object. The
# per-recipe Inputs schema also rejects unknown keys (Pydantic strict
# mode), but this is a cheap front-line defence so a 100k-key payload
# can't burn the schema-validator before bouncing.
_MAX_INPUT_KEYS = 32


class RunWorkflowIn(BaseModel):
    recipe: str = Field(min_length=1, max_length=64)
    inputs: dict[str, Any] = Field(default_factory=dict, max_length=_MAX_INPUT_KEYS)
    total_timeout_seconds: int | None = Field(default=None, ge=1)


@app.post("/run_workflow", response_model=workflow.WorkflowResult, tags=["xtb"])
async def run_workflow(
    req: Annotated[RunWorkflowIn, Body(...)],
) -> workflow.WorkflowResult:
    from services.mcp_tools.mcp_xtb.recipes import RECIPES

    wf = RECIPES.get(req.recipe)
    if wf is None:
        raise ValueError(
            f"unknown recipe {req.recipe!r}; available: "
            f"{sorted(RECIPES.keys())}",
        )
    # Engine validates inputs against ``wf.inputs_schema`` itself; failures
    # appear as a synthetic ``validate_inputs`` step with success=false in
    # the WorkflowResult body, not a 400.
    return await workflow.run(
        wf,
        req.inputs,
        total_timeout_s=_workflow_timeout_s(req.total_timeout_seconds),
        step_timeout_s=_step_timeout_s(),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_xtb.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
