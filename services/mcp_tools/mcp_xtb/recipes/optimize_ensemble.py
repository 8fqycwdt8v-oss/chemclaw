"""optimize_ensemble — CREST → optimise each conformer → Boltzmann re-weight.

Steps
-----
- ``embed``      : SMILES → 3-D xyz (RDKit) → ``workdir/mol.xyz``
- ``crest``      : ``crest mol.xyz`` → ``workdir/crest_conformers.xyz``
- ``parse``      : truncate to ``n_conformers``
- ``opt``        : per-conformer ``xtb --opt`` (parallel, bounded)
- ``boltzmann``  : weights from POST-opt energies at 298.15 K

Behaviour change vs the legacy ``/conformer_ensemble`` handler: weights
are now derived from optimised energies, not CREST's pre-opt energies,
and the partition function uses RT(298.15 K) ≈ 0.5925 kcal/mol rather
than the implicit RT = 1 kcal/mol the legacy code used.
"""

from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, Field

from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.mcp_xtb import _helpers
from services.mcp_tools.mcp_xtb import workflow as wf
from services.mcp_tools.mcp_xtb.workflow import Ctx, Step, Workflow

_HARTREE_TO_KCAL = 627.509
_RT_298_KCAL = 0.5925  # R·T at 298.15 K, kcal/mol

_MAX_PARALLEL_OPTS = 4
_MAX_CONFORMERS = 100


class Inputs(BaseModel):
    """Validated up-front by /run_workflow before the engine runs."""

    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    n_conformers: int = Field(default=20, ge=1, le=_MAX_CONFORMERS)
    method: Literal["GFN2-xTB", "GFN-FF"] = "GFN2-xTB"


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

async def _embed(ctx: Ctx) -> str:
    # Inputs are pre-validated by the engine against the Inputs schema.
    xyz = _helpers.smiles_to_xyz(ctx.inputs["smiles"])
    (ctx.workdir / "mol.xyz").write_text(xyz)
    return xyz


async def _crest(ctx: Ctx) -> str:
    result = await wf.run_subprocess(
        ["crest", "mol.xyz", "--T", "4", "--niceprint"],
        cwd=ctx.workdir,
        timeout_s=ctx.step_timeout_s,
    )
    if result.returncode != 0:
        raise ValueError(
            f"crest exit {result.returncode}: {result.stderr[:500]}",
        )
    ensemble = ctx.workdir / "crest_conformers.xyz"
    if not ensemble.exists():
        raise ValueError("crest did not produce crest_conformers.xyz")
    return ensemble.read_text()


async def _parse(ctx: Ctx) -> list[tuple[str, float]]:
    raw = _helpers.parse_crest_ensemble(ctx.artifacts["crest"])
    return raw[: ctx.inputs["n_conformers"]]


async def _opt(ctx: Ctx) -> list[tuple[str, float]]:
    raw: list[tuple[str, float]] = ctx.artifacts["parse"]
    gfn_flag = "--gfn2" if ctx.inputs["method"] == "GFN2-xTB" else "--gfnff"

    async def _opt_one(item: tuple[int, tuple[str, float]]) -> tuple[str, float]:
        idx, (xyz, _e_pre) = item
        d = ctx.workdir / f"conf_{idx}"
        d.mkdir(exist_ok=True)
        (d / "mol.xyz").write_text(xyz)
        result = await wf.run_subprocess(
            ["xtb", "mol.xyz", gfn_flag, "--opt", "tight", "--json"],
            cwd=d,
            timeout_s=ctx.step_timeout_s,
        )
        if result.returncode != 0:
            raise ValueError(
                f"xtb opt conf{idx} exit {result.returncode}: "
                f"{result.stderr[:500]}",
            )
        opt_xyz = d / "xtbopt.xyz"
        if not opt_xyz.exists():
            raise ValueError(f"xtb did not produce xtbopt.xyz for conf{idx}")
        energy = _helpers.parse_energy(result.stdout)
        if energy is None:
            raise ValueError(f"could not parse energy for conf{idx}")
        return (opt_xyz.read_text(), energy)

    return await wf.parallel_map(
        list(enumerate(raw)),
        _opt_one,
        max_concurrency=_MAX_PARALLEL_OPTS,
    )


async def _boltzmann(ctx: Ctx) -> list[dict[str, Any]]:
    pairs: list[tuple[str, float]] = ctx.artifacts["opt"]
    if not pairs:
        return []
    energies = [e for _, e in pairs]
    e_min = min(energies)
    exp_vals = [
        math.exp(-(e - e_min) * _HARTREE_TO_KCAL / _RT_298_KCAL)
        for e in energies
    ]
    z = sum(exp_vals) or 1.0
    return [
        {"xyz": xyz, "energy_hartree": e, "weight": v / z}
        for (xyz, e), v in zip(pairs, exp_vals, strict=True)
    ]


def _output(ctx: Ctx) -> dict[str, Any]:
    return {"conformers": ctx.artifacts["boltzmann"]}


WORKFLOW = Workflow(
    name="optimize_ensemble",
    inputs_schema=Inputs,
    steps=(
        Step(name="embed", fn=_embed),
        Step(name="crest", fn=_crest),
        Step(name="parse", fn=_parse),
        Step(name="opt", fn=_opt),
        Step(name="boltzmann", fn=_boltzmann),
    ),
    output=_output,
)
