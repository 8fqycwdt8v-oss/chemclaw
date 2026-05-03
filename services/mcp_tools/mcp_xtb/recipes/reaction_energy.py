"""reaction_energy — geometry-optimise reactant + product, return ΔE.

Inputs
------
- ``reactant_smiles`` : str
- ``product_smiles``  : str
- ``method``          : ``"GFN2-xTB"`` (default) | ``"GFN-FF"``

Outputs
-------
- ``reactant_energy_hartree`` : float
- ``product_energy_hartree``  : float
- ``delta_e_hartree``         : float (product − reactant)
- ``delta_e_kcal_mol``        : float

The two optimisations run concurrently inside one fan-out step so the
total wall-clock is bounded by the slower of the two rather than their
sum.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from pydantic import BaseModel, Field

from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.mcp_xtb import workflow as wf
from services.mcp_tools.mcp_xtb.workflow import Ctx, Step, Workflow

_HARTREE_TO_KCAL = 627.509


class Inputs(BaseModel):
    """Validated up-front by /run_workflow before the engine runs."""

    reactant_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    product_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    method: Literal["GFN2-xTB", "GFN-FF"] = "GFN2-xTB"


async def _opt_one(ctx: Ctx, smiles_key: str, subdir: str) -> tuple[str, float]:
    smiles = ctx.inputs[smiles_key]
    gfn_flag = "--gfn2" if ctx.inputs["method"] == "GFN2-xTB" else "--gfnff"

    from services.mcp_tools.mcp_xtb import main as _main

    d = ctx.workdir / subdir
    d.mkdir(exist_ok=True)
    (d / "mol.xyz").write_text(_main._smiles_to_xyz(smiles))

    result = await wf.run_subprocess(
        ["xtb", "mol.xyz", gfn_flag, "--opt", "tight", "--json"],
        cwd=d,
        timeout_s=ctx.step_timeout_s,
    )
    if result.returncode != 0:
        raise ValueError(
            f"xtb {subdir} exit {result.returncode}: {result.stderr[:500]}",
        )
    opt = d / "xtbopt.xyz"
    if not opt.exists():
        raise ValueError(f"xtb did not produce xtbopt.xyz in {subdir}")
    energy = _main._parse_energy(result.stdout)
    if energy is None:
        raise ValueError(f"could not parse energy for {subdir}")
    return (opt.read_text(), energy)


async def _opt_both(ctx: Ctx) -> dict[str, tuple[str, float]]:
    r, p = await asyncio.gather(
        _opt_one(ctx, "reactant_smiles", "reactant"),
        _opt_one(ctx, "product_smiles", "product"),
    )
    return {"reactant": r, "product": p}


def _output(ctx: Ctx) -> dict[str, Any]:
    pair = ctx.artifacts["opt_both"]
    _, e_r = pair["reactant"]
    _, e_p = pair["product"]
    delta = e_p - e_r
    return {
        "reactant_energy_hartree": e_r,
        "product_energy_hartree": e_p,
        "delta_e_hartree": delta,
        "delta_e_kcal_mol": delta * _HARTREE_TO_KCAL,
    }


WORKFLOW = Workflow(
    name="reaction_energy",
    inputs_schema=Inputs,
    steps=(
        Step(name="opt_both", fn=_opt_both),
    ),
    output=_output,
)
