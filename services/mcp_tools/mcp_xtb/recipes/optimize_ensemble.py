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
from typing import Any

from services.mcp_tools.mcp_xtb import workflow as wf
from services.mcp_tools.mcp_xtb.workflow import Ctx, Step, Workflow

_HARTREE_TO_KCAL = 627.509
_RT_298_KCAL = 0.5925  # R·T at 298.15 K, kcal/mol

_MAX_PARALLEL_OPTS = 4


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

async def _embed(ctx: Ctx) -> str:
    smiles = _require_str(ctx.inputs, "smiles")
    # Lazy import: avoids a circular import at module load time
    # (main.py registers /run_workflow which imports this package).
    from services.mcp_tools.mcp_xtb import main as _main

    xyz = _main._smiles_to_xyz(smiles)
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
    from services.mcp_tools.mcp_xtb import main as _main

    n = int(ctx.inputs.get("n_conformers", 20))
    raw = _main._parse_crest_ensemble(ctx.artifacts["crest"])
    return raw[:n]


async def _opt(ctx: Ctx) -> list[tuple[str, float]]:
    raw: list[tuple[str, float]] = ctx.artifacts["parse"]
    method = str(ctx.inputs.get("method", "GFN2-xTB"))
    gfn_flag = "--gfn2" if method == "GFN2-xTB" else "--gfnff"

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

        from services.mcp_tools.mcp_xtb import main as _main

        energy = _main._parse_energy(result.stdout)
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _require_str(inputs: dict[str, Any], key: str) -> str:
    v = inputs.get(key)
    if not isinstance(v, str) or not v.strip():
        raise ValueError(f"input {key!r} required (non-empty string)")
    return v


WORKFLOW = Workflow(
    name="optimize_ensemble",
    steps=(
        Step(name="embed", fn=_embed),
        Step(name="crest", fn=_crest),
        Step(name="parse", fn=_parse),
        Step(name="opt", fn=_opt),
        Step(name="boltzmann", fn=_boltzmann),
    ),
    output=_output,
)
