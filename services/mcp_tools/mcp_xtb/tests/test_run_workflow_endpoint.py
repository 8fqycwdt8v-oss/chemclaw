"""HTTP-level tests for /run_workflow."""
from __future__ import annotations

from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.mcp_xtb import workflow as wf

_FAKE_XYZ = "3\nCCO\nC 0 0 0\nC 1.5 0 0\nO 2 1.2 0\n"
_FAKE_OPTIMIZED_XYZ = "3\nCCO opt\nC 0.001 0 0\nC 1.501 0 0\nO 2.001 1.201 0\n"


@pytest.fixture()
def client():
    with mock.patch("shutil.which", return_value="/usr/local/bin/xtb"):
        from services.mcp_tools.mcp_xtb.main import app
        with TestClient(app) as c:
            yield c


def test_input_validation_failure_appears_as_validate_inputs_step(client):
    """Bad inputs surface as a synthetic validate_inputs step with
    success=false in the body, not as a 400."""
    r = client.post(
        "/run_workflow",
        json={
            "recipe": "reaction_energy",
            "inputs": {"reactant_smiles": "CCO"},  # missing product_smiles
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is False
    assert body["steps"][0]["name"] == "validate_inputs"
    assert body["steps"][0]["ok"] is False
    assert "product_smiles" in body["steps"][0]["error"]


def test_input_size_cap_returns_422(client):
    """The body-size cap on inputs is enforced before validation."""
    huge_inputs = {f"k{i}": "x" for i in range(100)}
    r = client.post(
        "/run_workflow",
        json={"recipe": "reaction_energy", "inputs": huge_inputs},
    )
    assert r.status_code == 422


def test_unknown_recipe_returns_400(client):
    r = client.post("/run_workflow", json={"recipe": "no_such", "inputs": {}})
    assert r.status_code == 400
    assert "no_such" in r.json()["detail"]


def test_run_workflow_recipe_listing_shape(client):
    r = client.post("/run_workflow", json={"recipe": "no_such", "inputs": {}})
    assert "available" in r.json()["detail"]
    assert "optimize_ensemble" in r.json()["detail"]
    assert "reaction_energy" in r.json()["detail"]


def test_run_workflow_reaction_energy_happy_path(client):
    async def _fake(args, cwd, timeout_s):
        cwd_p = Path(cwd)
        (cwd_p / "xtbopt.xyz").write_text(_FAKE_OPTIMIZED_XYZ)
        energy = -5.0 if cwd_p.name == "reactant" else -5.05
        return wf.SubprocessResult(
            returncode=0,
            stdout=f"TOTAL ENERGY          {energy:.6f} Eh\n",
            stderr="",
        )

    with mock.patch(
        "services.mcp_tools.mcp_xtb.main._smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.workflow.run_subprocess",
        side_effect=_fake,
    ):
        r = client.post(
            "/run_workflow",
            json={
                "recipe": "reaction_energy",
                "inputs": {"reactant_smiles": "CCO", "product_smiles": "CC=O"},
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["recipe"] == "reaction_energy"
    assert body["success"] is True
    assert body["outputs"]["delta_e_hartree"] == pytest.approx(-0.05, rel=1e-4)
    assert all(s["ok"] for s in body["steps"])


def test_run_workflow_failed_step_returns_200_with_success_false(client):
    """Recipe-level failures are reported in the body, not as 4xx — the
    agent gets full timing info even on failure."""
    async def _fake(args, cwd, timeout_s):
        return wf.SubprocessResult(returncode=1, stdout="", stderr="boom")

    with mock.patch(
        "services.mcp_tools.mcp_xtb.main._smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.workflow.run_subprocess",
        side_effect=_fake,
    ):
        r = client.post(
            "/run_workflow",
            json={
                "recipe": "reaction_energy",
                "inputs": {"reactant_smiles": "CCO", "product_smiles": "CC=O"},
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is False
    assert body["outputs"] == {}
    assert any(not s["ok"] for s in body["steps"])


def test_run_workflow_caps_total_timeout_at_ceiling(client):
    """Caller-supplied total_timeout_seconds is clamped server-side."""
    captured: dict[str, int] = {}

    async def _fake_run(_wf, _inputs, *, total_timeout_s, step_timeout_s=120):
        captured["total"] = total_timeout_s
        return wf.WorkflowResult(
            recipe="reaction_energy",
            success=True,
            steps=[],
            outputs={"delta_e_hartree": 0.0},
            warnings=[],
            total_seconds=0.0,
        )

    with mock.patch("services.mcp_tools.mcp_xtb.workflow.run", side_effect=_fake_run):
        r = client.post(
            "/run_workflow",
            json={
                "recipe": "reaction_energy",
                "inputs": {"reactant_smiles": "CCO", "product_smiles": "CC=O"},
                "total_timeout_seconds": 99_999,
            },
        )
    assert r.status_code == 200
    assert captured["total"] == 1800  # _HARD_WORKFLOW_TIMEOUT_CEILING_S
