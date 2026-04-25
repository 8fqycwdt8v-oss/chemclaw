"""Tests for mcp-xtb FastAPI app.

subprocess (xtb/crest) and RDKit _smiles_to_xyz are mocked.
No xtb binary or rdkit required in dev .venv for these tests.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient

# Minimal valid XYZ block for a single-atom test.
_FAKE_XYZ = """\
3
CCO
C   0.000000   0.000000   0.000000
C   1.500000   0.000000   0.000000
O   2.000000   1.200000   0.000000
"""

_FAKE_OPTIMIZED_XYZ = """\
3
CCO optimized
C   0.001000   0.000000   0.000000
C   1.501000   0.000000   0.000000
O   2.001000   1.201000   0.000000
"""

_FAKE_STDOUT_OPT = """\
...
TOTAL ENERGY          -5.123456789000 Eh
GRADIENT NORM          0.000234 Eh/a0
GEOMETRY CONVERGED
"""

_FAKE_CREST_ENSEMBLE = """\
3
-5.1234 CCO
C   0.001   0.000   0.000
C   1.501   0.000   0.000
O   2.001   1.201   0.000
3
-5.1000 CCO conf2
C   0.002   0.001   0.001
C   1.502   0.001   0.001
O   2.002   1.202   0.001
"""


def _make_mock_subprocess_result(returncode: int = 0, stdout: str = "", stderr: str = ""):
    result = mock.MagicMock(spec=subprocess.CompletedProcess)
    result.returncode = returncode
    result.stdout = stdout
    result.stderr = stderr
    return result


@pytest.fixture()
def client():
    with mock.patch("shutil.which", return_value="/usr/local/bin/xtb"):
        from services.mcp_tools.mcp_xtb.main import app
        with TestClient(app) as c:
            yield c


# ---------------------------------------------------------------------------
# /readyz
# ---------------------------------------------------------------------------

def test_readyz_503_when_xtb_missing():
    with mock.patch("shutil.which", return_value=None):
        from services.mcp_tools.mcp_xtb.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_readyz_200_when_xtb_present():
    with mock.patch("shutil.which", return_value="/usr/local/bin/xtb"):
        from services.mcp_tools.mcp_xtb.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 200


# ---------------------------------------------------------------------------
# /optimize_geometry
# ---------------------------------------------------------------------------

def test_optimize_geometry_happy_path(client, tmp_path):
    proc_result = _make_mock_subprocess_result(stdout=_FAKE_STDOUT_OPT)

    # Write the fake xtbopt.xyz into a tempdir that the handler will actually see.
    def fake_run_xtb(args, cwd):
        # Write the output file into the cwd that the handler passes.
        (Path(cwd) / "xtbopt.xyz").write_text(_FAKE_OPTIMIZED_XYZ)
        return proc_result

    with mock.patch(
        "services.mcp_tools.mcp_xtb.main._smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.main._run_xtb",
        side_effect=fake_run_xtb,
    ):
        r = client.post(
            "/optimize_geometry",
            json={"smiles": "CCO", "method": "GFN2-xTB"},
        )

    assert r.status_code == 200
    body = r.json()
    assert body["converged"] is True
    assert body["energy_hartree"] == pytest.approx(-5.123456789)
    assert body["gnorm"] == pytest.approx(0.000234)


def test_optimize_geometry_invalid_smiles_returns_400(client):
    with mock.patch(
        "services.mcp_tools.mcp_xtb.main._smiles_to_xyz",
        side_effect=ValueError("invalid SMILES"),
    ):
        r = client.post(
            "/optimize_geometry",
            json={"smiles": "NOTVALID!!!"},
        )
    assert r.status_code == 400


def test_optimize_geometry_method_enum_rejected(client):
    r = client.post(
        "/optimize_geometry",
        json={"smiles": "CCO", "method": "PM7"},
    )
    assert r.status_code == 422


def test_xtb_process_failure_raises_400(client):
    proc_result = _make_mock_subprocess_result(returncode=1, stderr="SCF did not converge")
    with mock.patch(
        "services.mcp_tools.mcp_xtb.main._smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.main._run_xtb",
        return_value=proc_result,
    ):
        r = client.post(
            "/optimize_geometry",
            json={"smiles": "CCO"},
        )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# /conformer_ensemble
# ---------------------------------------------------------------------------

def test_conformer_ensemble_happy_path(client):
    proc_result = _make_mock_subprocess_result(stdout="CREST done")

    with mock.patch(
        "services.mcp_tools.mcp_xtb.main._smiles_to_xyz",
        return_value=_FAKE_XYZ,
    ), mock.patch(
        "services.mcp_tools.mcp_xtb.main._run_xtb",
        return_value=proc_result,
    ), mock.patch(
        "pathlib.Path.exists",
        return_value=True,
    ), mock.patch(
        "pathlib.Path.read_text",
        return_value=_FAKE_CREST_ENSEMBLE,
    ):
        r = client.post(
            "/conformer_ensemble",
            json={"smiles": "CCO", "n_conformers": 5},
        )

    assert r.status_code == 200
    body = r.json()
    assert len(body["conformers"]) == 2  # only 2 in the fake ensemble
    total_weight = sum(c["weight"] for c in body["conformers"])
    assert total_weight == pytest.approx(1.0)


def test_conformer_ensemble_n_conformers_max(client):
    r = client.post(
        "/conformer_ensemble",
        json={"smiles": "CCO", "n_conformers": 101},
    )
    assert r.status_code == 422


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-xtb"
