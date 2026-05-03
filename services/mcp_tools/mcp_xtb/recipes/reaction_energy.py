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
from typing import Any

from services.mcp_tools.mcp_xtb import workflow as wf
from services.mcp_tools.mcp_xtb.workflow import Ctx, Step, Workflow

_HARTREE_TO_KCAL = 627.509


async def _opt_one(ctx: Ctx, smiles_key: str, subdir: str) -> tuple[str, float]:
    smiles = ctx.inputs.get(smiles_key)
    if not isinstance(smiles, str) or not smiles.strip():
        raise ValueError(f"input {smiles_key!r} required (non-empty string)")
    method = str(ctx.inputs.get("method", "GFN2-xTB"))
    gfn_flag = "--gfn2" if method == "GFN2-xTB" else "--gfnff"

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
    # Validate up-front so a missing input fails fast instead of after a
    # subprocess launch attempt for the half-valid pair.
    for k in ("reactant_smiles", "product_smiles"):
        v = ctx.inputs.get(k)
        if not isinstance(v, str) or not v.strip():
            raise ValueError(f"input {k!r} required (non-empty string)")
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
    steps=(
        Step(name="opt_both", fn=_opt_both),
    ),
    output=_output,
)
