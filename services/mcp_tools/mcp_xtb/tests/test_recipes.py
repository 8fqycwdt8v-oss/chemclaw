"""Recipe end-to-end tests against stubbed ``workflow.run_subprocess``."""
from __future__ import annotations

from pathlib import Path
from unittest import mock

import pytest

from services.mcp_tools.mcp_xtb import workflow as wf

_FAKE_XYZ = """\
3
CCO
C   0.000   0.000   0.000
C   1.500   0.000   0.000
O   2.000   1.200   0.000
"""

_FAKE_OPTIMIZED_XYZ = """\
3
CCO opt
C   0.001   0.000   0.000
C   1.501   0.000   0.000
O   2.001   1.201   0.000
"""

_FAKE_STDOUT_OPT = "TOTAL ENERGY          -5.123456789000 Eh\nGEOMETRY CONVERGED\n"

_FAKE_CREST_ENSEMBLE = """\
3
-5.1234 conf1
C   0.001   0.000   0.000
C   1.501   0.000   0.000
O   2.001   1.201   0.000
3
-5.1000 conf2
C   0.002   0.001   0.001
C   1.502   0.001   0.001
O   2.002   1.202   0.001
3
-5.0500 conf3
C   0.003   0.001   0.001
C   1.503   0.001   0.001
O   2.003   1.203   0.001
"""


def _fake_subprocess_factory(opt_stdout: str = _FAKE_STDOUT_OPT,
                              ensemble: str = _FAKE_CREST_ENSEMBLE):
    async def _fake(args, cwd, timeout_s):
        cmd = args[0]
        cwd_p = Path(cwd)
        if cmd == "crest":
            (cwd_p / "crest_conformers.xyz").write_text(ensemble)
            return wf.SubprocessResult(returncode=0, stdout="ok", stderr="")
        if cmd == "xtb":
            (cwd_p / "xtbopt.xyz").write_text(_FAKE_OPTIMIZED_XYZ)
            return wf.SubprocessResult(returncode=0, stdout=opt_stdout, stderr="")
        raise AssertionError(f"unexpected subprocess call: {args!r}")

    return _fake


# ---------------------------------------------------------------------------
# optimize_ensemble
# ---------------------------------------------------------------------------

async def test_optimize_ensemble_full_pipeline():
    from services.mcp_tools.mcp_xtb.recipes import optimize_ensemble

    with mock.patch(
        "services.mcp_tools.mcp_xtb._helpers.smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.workflow.run_subprocess",
        side_effect=_fake_subprocess_factory(),
    ):
        res = await wf.run(
            optimize_ensemble.WORKFLOW,
            {"smiles": "CCO", "n_conformers": 5},
            total_timeout_s=30,
        )
    assert res.success, res.steps
    assert [s.name for s in res.steps] == [
        "validate_inputs", "embed", "crest", "parse", "opt", "boltzmann",
    ]
    confs = res.outputs["conformers"]
    assert len(confs) == 3
    weights = [c["weight"] for c in confs]
    assert sum(weights) == pytest.approx(1.0)
    # All three conformers are POST-opt, so they share the same parsed energy.
    assert all(c["energy_hartree"] == pytest.approx(-5.123456789) for c in confs)


async def test_optimize_ensemble_boltzmann_weights_match_RT_298():
    """Three conformers with energies 0, +0.5, +1.0 kcal/mol relative to
    the minimum should produce weights consistent with RT(298 K) ≈
    0.5925 kcal/mol — i.e. NOT the legacy implicit RT = 1 kcal/mol that
    used a partition function of exp(-ΔE_kcal).

    Expected at 298 K: w_i ∝ exp(-ΔE_i / 0.5925).
    """
    import math
    from services.mcp_tools.mcp_xtb.recipes import optimize_ensemble

    # 3 distinct post-opt energies. conf_0 is the minimum; conf_1 and
    # conf_2 sit 0.5 and 1.0 kcal/mol above it. Adding (positive) ΔE in
    # hartree to the minimum (-5.0 Eh) makes the energy LESS negative,
    # i.e. higher.
    HARTREE_TO_KCAL = 627.509
    deltas_kcal = [0.0, 0.5, 1.0]
    e_min_hartree = -5.0
    energies_hartree = [e_min_hartree + d / HARTREE_TO_KCAL for d in deltas_kcal]

    # Map by conf directory so the energy assignment is deterministic
    # regardless of which parallel xtb worker finishes first.
    by_conf = {f"conf_{i}": e for i, e in enumerate(energies_hartree)}

    async def _fake(args, cwd, timeout_s):
        cmd = args[0]
        cwd_p = Path(cwd)
        if cmd == "crest":
            (cwd_p / "crest_conformers.xyz").write_text(_FAKE_CREST_ENSEMBLE)
            return wf.SubprocessResult(returncode=0, stdout="ok", stderr="")
        if cmd == "xtb":
            (cwd_p / "xtbopt.xyz").write_text(_FAKE_OPTIMIZED_XYZ)
            e = by_conf[cwd_p.name]
            return wf.SubprocessResult(
                returncode=0,
                stdout=f"TOTAL ENERGY          {e:.9f} Eh\n",
                stderr="",
            )
        raise AssertionError(f"unexpected: {args!r}")

    with mock.patch(
        "services.mcp_tools.mcp_xtb._helpers.smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.workflow.run_subprocess",
        side_effect=_fake,
    ):
        res = await wf.run(
            optimize_ensemble.WORKFLOW,
            {"smiles": "CCO", "n_conformers": 3, "method": "GFN2-xTB"},
            total_timeout_s=30,
        )

    assert res.success, res.steps
    confs = res.outputs["conformers"]
    assert len(confs) == 3
    weights = [c["weight"] for c in confs]
    assert sum(weights) == pytest.approx(1.0)

    expected = [math.exp(-d / 0.5925) for d in deltas_kcal]
    z = sum(expected)
    expected_norm = [v / z for v in expected]
    for got, exp in zip(weights, expected_norm, strict=True):
        assert got == pytest.approx(exp, rel=1e-4)

    # Sanity: at RT(298 K) ≈ 0.5925 kcal/mol the weight ratio between the
    # minimum and a +0.5 kcal/mol conformer is e^(0.5/0.5925) ≈ 2.31. The
    # legacy implicit RT = 1 kcal/mol code would have given e^0.5 ≈ 1.65.
    assert weights[0] / weights[1] == pytest.approx(math.exp(0.5 / 0.5925), rel=1e-4)


async def test_optimize_ensemble_caps_at_n_conformers():
    from services.mcp_tools.mcp_xtb.recipes import optimize_ensemble

    with mock.patch(
        "services.mcp_tools.mcp_xtb._helpers.smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.workflow.run_subprocess",
        side_effect=_fake_subprocess_factory(),
    ):
        res = await wf.run(
            optimize_ensemble.WORKFLOW,
            {"smiles": "CCO", "n_conformers": 2},
            total_timeout_s=30,
        )
    assert res.success
    assert len(res.outputs["conformers"]) == 2


async def test_optimize_ensemble_crest_failure_reports_step():
    from services.mcp_tools.mcp_xtb.recipes import optimize_ensemble

    async def _fake(args, cwd, timeout_s):
        if args[0] == "crest":
            return wf.SubprocessResult(returncode=1, stdout="", stderr="crest exploded")
        raise AssertionError("xtb should not run")

    with mock.patch(
        "services.mcp_tools.mcp_xtb._helpers.smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.workflow.run_subprocess",
        side_effect=_fake,
    ):
        res = await wf.run(
            optimize_ensemble.WORKFLOW,
            {"smiles": "CCO"},
            total_timeout_s=30,
        )
    assert not res.success
    failed = next(s for s in res.steps if not s.ok)
    assert failed.name == "crest"
    assert "crest exploded" in (failed.error or "")


# ---------------------------------------------------------------------------
# reaction_energy
# ---------------------------------------------------------------------------

async def test_reaction_energy_computes_delta():
    from services.mcp_tools.mcp_xtb.recipes import reaction_energy

    # Distinct energies for reactant vs product so ΔE is non-zero.
    state = {"calls": 0}

    async def _fake(args, cwd, timeout_s):
        cwd_p = Path(cwd)
        (cwd_p / "xtbopt.xyz").write_text(_FAKE_OPTIMIZED_XYZ)
        # First call → reactant, second → product (order is gather()-dependent
        # but on CPython the first awaited launches first; we differentiate by
        # cwd basename to be deterministic).
        state["calls"] += 1
        energy = -5.0 if cwd_p.name == "reactant" else -5.05
        return wf.SubprocessResult(
            returncode=0,
            stdout=f"TOTAL ENERGY          {energy:.6f} Eh\n",
            stderr="",
        )

    with mock.patch(
        "services.mcp_tools.mcp_xtb._helpers.smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.workflow.run_subprocess",
        side_effect=_fake,
    ):
        res = await wf.run(
            reaction_energy.WORKFLOW,
            {"reactant_smiles": "CCO", "product_smiles": "CC=O"},
            total_timeout_s=30,
        )
    assert res.success, res.steps
    assert state["calls"] == 2
    out = res.outputs
    assert out["reactant_energy_hartree"] == pytest.approx(-5.0)
    assert out["product_energy_hartree"] == pytest.approx(-5.05)
    assert out["delta_e_hartree"] == pytest.approx(-0.05)
    assert out["delta_e_kcal_mol"] == pytest.approx(-0.05 * 627.509)


async def test_reaction_energy_rejects_missing_input():
    from services.mcp_tools.mcp_xtb.recipes import reaction_energy

    res = await wf.run(
        reaction_energy.WORKFLOW,
        {"reactant_smiles": "CCO"},  # missing product_smiles
        total_timeout_s=10,
    )
    assert not res.success
    failed = next(s for s in res.steps if not s.ok)
    assert "product_smiles" in (failed.error or "")
