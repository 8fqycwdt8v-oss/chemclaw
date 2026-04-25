"""Tests for mcp-sirius FastAPI app.

sirius binary and subprocess are mocked — no JVM required in dev .venv.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    with mock.patch("shutil.which", return_value="/usr/local/bin/sirius"):
        from services.mcp_tools.mcp_sirius.main import app
        with TestClient(app) as c:
            yield c


_VALID_PEAKS = [
    {"m_z": 100.0, "intensity": 1000.0},
    {"m_z": 150.5, "intensity": 500.0},
    {"m_z": 200.0, "intensity": 200.0},
]

_SIRIUS_RESULTS = [
    {
        "smiles": "CC(=O)Oc1ccccc1C(=O)O",
        "molecularFormula": "C9H8O4",
        "csiScore": -0.12,
        "classyfireResult": {
            "kingdom": {"name": "Organic compounds"},
            "superclass": {"name": "Benzenoids"},
            "class": {"name": "Benzene and substituted derivatives"},
        },
    }
]


def _make_mock_subprocess_result(returncode: int = 0, stdout: str = "", stderr: str = ""):
    result = mock.MagicMock(spec=subprocess.CompletedProcess)
    result.returncode = returncode
    result.stdout = stdout
    result.stderr = stderr
    return result


# ---------------------------------------------------------------------------
# /readyz
# ---------------------------------------------------------------------------

def test_readyz_503_when_sirius_missing():
    with mock.patch("shutil.which", return_value=None):
        from services.mcp_tools.mcp_sirius.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_readyz_200_when_sirius_present():
    with mock.patch("shutil.which", return_value="/usr/local/bin/sirius"):
        from services.mcp_tools.mcp_sirius.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 200


# ---------------------------------------------------------------------------
# /identify
# ---------------------------------------------------------------------------

def test_identify_happy_path(client, tmp_path):
    proc_result = _make_mock_subprocess_result(returncode=0)

    # Write fake structure_candidates.json in a temp dir.
    fake_output = tmp_path / "results"
    fake_output.mkdir()
    (fake_output / "structure_candidates.json").write_text(
        json.dumps(_SIRIUS_RESULTS)
    )

    with mock.patch(
        "services.mcp_tools.mcp_sirius.main._run_sirius",
        return_value=proc_result,
    ), mock.patch(
        "services.mcp_tools.mcp_sirius.main._parse_sirius_results",
        return_value=[
            # Inline a parsed StructureCandidate to avoid Path mocking complexity.
        ],
    ):
        r = client.post(
            "/identify",
            json={
                "ms2_peaks": _VALID_PEAKS,
                "precursor_mz": 200.5,
                "ionization": "positive",
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert "candidates" in body


def test_identify_sirius_failure_returns_400(client):
    proc_result = _make_mock_subprocess_result(returncode=1, stderr="Java heap error")
    with mock.patch(
        "services.mcp_tools.mcp_sirius.main._run_sirius",
        return_value=proc_result,
    ), mock.patch(
        "services.mcp_tools.mcp_sirius.main._parse_sirius_results",
        return_value=[],
    ):
        r = client.post(
            "/identify",
            json={
                "ms2_peaks": _VALID_PEAKS,
                "precursor_mz": 200.5,
                "ionization": "positive",
            },
        )
    assert r.status_code == 400


def test_identify_invalid_ionization_rejected(client):
    r = client.post(
        "/identify",
        json={
            "ms2_peaks": _VALID_PEAKS,
            "precursor_mz": 200.5,
            "ionization": "neutral",
        },
    )
    assert r.status_code == 422


def test_identify_precursor_mz_zero_rejected(client):
    r = client.post(
        "/identify",
        json={
            "ms2_peaks": _VALID_PEAKS,
            "precursor_mz": 0.0,
            "ionization": "positive",
        },
    )
    assert r.status_code == 422


def test_peaks_to_mgf_format():
    from services.mcp_tools.mcp_sirius.main import Ms2Peak, _peaks_to_mgf
    peaks = [Ms2Peak(m_z=100.0, intensity=1000.0)]
    mgf = _peaks_to_mgf(peaks, 200.5, "positive")
    assert "PEPMASS=200.500000" in mgf
    assert "CHARGE=+1" in mgf
    assert "100.000000 1000.0000" in mgf


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-sirius"
