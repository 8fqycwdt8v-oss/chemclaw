"""Tests for the qm_kg projector — focused on the Cypher shape, not Postgres I/O.

The projector subscribes to `qm_job_succeeded` and writes nodes/edges through
the neo4j driver. We patch the driver and assert the right Cypher fragments
fire for a representative job + conformer ensemble.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from services.projectors.qm_kg.main import QmKgProjector, QmKgProjectorSettings


@pytest.fixture
def projector() -> QmKgProjector:
    settings = QmKgProjectorSettings(
        postgres_host="localhost",
        postgres_db="chemclaw",
        postgres_user="chemclaw",
        postgres_password="",
        neo4j_uri="bolt://localhost:7687",
        neo4j_user="neo4j",
        neo4j_password="",
    )
    return QmKgProjector(settings)


def _fake_session_calls(driver: MagicMock) -> list[tuple[str, dict]]:
    """Record (cypher, params) tuples for every session.run call."""
    calls: list[tuple[str, dict]] = []

    class _FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def run(self, cypher: str, **params):
            calls.append((cypher, params))
            return None

    driver.session.return_value = _FakeSession()
    return calls


def test_merge_writes_compound_calculation_and_conformers(projector: QmKgProjector) -> None:
    fake_driver = MagicMock()
    calls = _fake_session_calls(fake_driver)
    projector._neo4j_driver = fake_driver

    row = {
        "id": "11111111-1111-1111-1111-111111111111",
        "method": "GFN2",
        "task": "conformers",
        "smiles_canonical": "CCO",
        "inchikey": "LFQSCWFLJHTTHZ-UHFFFAOYSA-N",
        "charge": 0,
        "multiplicity": 1,
        "solvent_model": "alpb",
        "solvent_name": "water",
        "params": {},
        "version_xtb": "6.7.0",
        "version_crest": "3.0.1",
        "valid_from": None,
        "valid_to": None,
        "energy_hartree": -154.123,
        "converged": True,
        "summary_md": "ok",
        "descriptors": None,
        "charges": None,
        "fukui": None,
    }
    conformers = [
        {"ensemble_index": 0, "energy_hartree": -154.123, "boltzmann_weight": 0.7},
        {"ensemble_index": 1, "energy_hartree": -154.118, "boltzmann_weight": 0.3},
    ]

    projector._merge_into_neo4j(row, conformers)

    # Three Cypher chunks expected: close-prior + merge-calc + N×conformer.
    assert len(calls) == 1 + 1 + len(conformers), [c[0][:40] for c in calls]
    close_prior = calls[0][0]
    assert "valid_to = datetime()" in close_prior
    merge_calc = calls[1][0]
    assert "MERGE (c:Compound" in merge_calc
    assert "MERGE (cr:CalculationResult" in merge_calc
    assert "HAS_CALCULATION" in merge_calc
    # All N conformer MERGEs reference the right job id.
    for i, c in enumerate(conformers):
        cypher, params = calls[2 + i]
        assert "Conformer" in cypher
        assert params["job_id"] == row["id"]
        assert params["idx"] == c["ensemble_index"]


def test_merge_handles_missing_inchikey(projector: QmKgProjector) -> None:
    fake_driver = MagicMock()
    _fake_session_calls(fake_driver)
    projector._neo4j_driver = fake_driver

    row = {
        "id": "22222222-2222-2222-2222-222222222222",
        "method": "GFN2",
        "task": "sp",
        "smiles_canonical": "C",
        "inchikey": None,
        "charge": 0,
        "multiplicity": 1,
        "solvent_model": None,
        "solvent_name": None,
        "params": {},
        "version_xtb": None,
        "version_crest": None,
        "valid_from": None,
        "valid_to": None,
        "energy_hartree": -1.0,
        "converged": True,
        "summary_md": None,
        "descriptors": None,
        "charges": None,
        "fukui": None,
    }
    # Should not raise even though inchikey is None — the projector falls
    # back to "" so the Compound node still merges (just without a real key).
    projector._merge_into_neo4j(row, [])
