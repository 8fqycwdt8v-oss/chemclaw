"""Regression tests for the g-xTB 501 not_implemented contract.

History: prior to this guard, ``method="g-xTB"`` mapped to ``--gfn 2 --general``
in `_shared._METHOD_FLAGS`. ``--general`` is not a valid `xtb` flag, so xtb
either errored or silently ignored it and ran GFN2; either way the resulting
row landed in `qm_jobs` keyed as ``method='g-xTB'`` and the `qm_kg` projector
projected a Neo4j ``:CalculationResult`` node with the wrong method label,
poisoning the cache and the KG. The fix surfaces 501 BEFORE the cache check
on every endpoint that accepts a free-form ``QmMethod``.

These tests assert the contract for all seven affected endpoints. The other
QM endpoints either hardcode the method (`/excited_states` → sTDA-xTB,
`/redox` → IPEA-xTB) or accept a narrower compat schema that excludes
g-xTB (`/optimize_geometry`, `/conformer_ensemble`).
"""
from __future__ import annotations

from unittest import mock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    # `xtb` is "available" so /readyz returns 200 and the auth middleware
    # routes the request through to the handler. `gxtb` is *not* — that's
    # what we're testing.
    def _which(name: str, *_args, **_kwargs) -> str | None:
        if name == "xtb":
            return "/usr/local/bin/xtb"
        if name == "gxtb":
            return None
        return None

    with mock.patch("shutil.which", side_effect=_which):
        from services.mcp_tools.mcp_xtb.main import app
        with TestClient(app) as c:
            yield c


# Endpoint, request body. Bodies use the minimum-valid shape per endpoint;
# `method="g-xTB"` is the bit under test. Every endpoint here accepts
# `QmMethod` directly (or via QmReqBase / GeomOptIn / ChargesIn / RelaxedScanIn /
# MdIn) — i.e. the surface where the placeholder used to silently mis-route.
_GXTB_ENDPOINTS = [
    ("/single_point", {"smiles": "CCO", "method": "g-xTB"}),
    ("/geometry_opt", {"smiles": "CCO", "method": "g-xTB"}),
    ("/frequencies", {"smiles": "CCO", "method": "g-xTB"}),
    (
        "/relaxed_scan",
        {
            "smiles": "CCO",
            "method": "g-xTB",
            "coord_def": {"type": "bond", "atoms": [1, 2], "range": [1.0, 1.5, 0.1]},
        },
    ),
    ("/md", {"smiles": "CCO", "method": "g-xTB", "n_steps": 100}),
    ("/fukui", {"smiles": "CCO", "method": "g-xTB"}),
    ("/charges", {"smiles": "CCO", "method": "g-xTB"}),
]


@pytest.mark.parametrize(("path", "body"), _GXTB_ENDPOINTS)
def test_gxtb_returns_501_not_implemented(client, path, body):
    """501 fires BEFORE any subprocess is spawned and BEFORE the cache is
    consulted, so a poisoned legacy row can't return a misleading 200.

    The mocks on `_smiles_to_canonical_and_xyz`, `_run_xtb`, and
    `_check_cache` would record any call; the assertions at the bottom
    confirm the guard short-circuits earlier than all three.
    """
    from services.mcp_tools.mcp_xtb import main

    with mock.patch.object(
        main, "_smiles_to_canonical_and_xyz",
    ) as smiles_mock, mock.patch.object(
        main, "_run_xtb",
    ) as run_mock, mock.patch.object(
        main, "_check_cache",
    ) as cache_mock:
        r = client.post(path, json=body)

    assert r.status_code == 501, r.text
    payload = r.json()
    assert payload["error"] == "not_implemented"
    assert "g-xTB" in payload["detail"]
    assert "gxtb" in payload["detail"]
    # Guard short-circuits before any of these are called.
    smiles_mock.assert_not_called()
    run_mock.assert_not_called()
    cache_mock.assert_not_called()


def test_gxtb_passes_through_when_binary_present(client, monkeypatch):
    """`_gxtb_available()` is the single switch that lifts the 501.

    When a future image bundles the real `gxtb` binary the toggle flips
    to True and the same request flows through to the cache layer. The
    test mocks `_check_cache` to short-circuit at that point; we don't
    need to drive the full xtb pipeline to assert the toggle contract.
    """
    from services.mcp_tools.mcp_xtb import main

    monkeypatch.setattr(main, "_gxtb_available", lambda: True)
    fake_cached = mock.MagicMock(
        job_id="00000000-0000-0000-0000-000000000000",
        method="g-xTB",
        summary_md="cached g-xTB",
        energy_hartree=-5.0,
    )
    with mock.patch.object(
        main, "_smiles_to_canonical_and_xyz",
        return_value=("CCO", "3\nCCO\nC 0 0 0\nC 1.5 0 0\nO 2 1.2 0\n", "CCO-INCHI"),
    ), mock.patch.object(
        main, "_check_cache", return_value=fake_cached,
    ):
        r = client.post("/single_point", json={"smiles": "CCO", "method": "g-xTB"})
    assert r.status_code == 200, r.text
    assert r.json()["method"] == "g-xTB"


def test_gfn2_unaffected_by_guard(client):
    """The guard is method-specific — non-g-xTB requests still flow."""
    from services.mcp_tools.mcp_xtb import main

    fake_cached = mock.MagicMock(
        job_id="11111111-1111-1111-1111-111111111111",
        method="GFN2",
        summary_md="cached GFN2",
        energy_hartree=-5.123,
    )
    with mock.patch.object(
        main, "_smiles_to_canonical_and_xyz",
        return_value=("CCO", "3\nCCO\nC 0 0 0\nC 1.5 0 0\nO 2 1.2 0\n", "CCO-INCHI"),
    ), mock.patch.object(
        main, "_check_cache", return_value=fake_cached,
    ):
        r = client.post("/single_point", json={"smiles": "CCO", "method": "GFN2"})
    assert r.status_code == 200
    assert r.json()["method"] == "GFN2"


def test_method_flags_raises_for_gxtb():
    """Direct unit-level guard: even if a caller bypasses the endpoint
    and reaches `method_flags` (e.g. via the recipe engine in a future
    refactor), the helper refuses to mint a placeholder flag list."""
    from services.mcp_tools.mcp_xtb._shared import method_flags

    with pytest.raises(NotImplementedError, match="gxtb"):
        method_flags("g-xTB")


def test_gxtb_available_probes_path():
    """`_gxtb_available` is a pure shutil.which probe; mocking the
    return is sufficient to flip behaviour everywhere it's read."""
    from services.mcp_tools.mcp_xtb._shared import gxtb_available

    with mock.patch("shutil.which", return_value=None):
        assert gxtb_available() is False
    with mock.patch("shutil.which", return_value="/usr/local/bin/gxtb"):
        assert gxtb_available() is True
