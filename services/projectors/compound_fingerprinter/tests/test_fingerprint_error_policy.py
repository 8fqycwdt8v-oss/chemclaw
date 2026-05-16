"""Error-policy + rollback tests for CompoundFingerprinter._fingerprint.

Mirrors the chunk_embedder error-policy pattern: mock httpx at the
AsyncClient level and psycopg at the connection level so these tests run
without any infrastructure. The goal is to verify:

  1. When mcp-rdkit returns 4xx on a fingerprint call, PermanentHandlerError
     is raised and work_conn.rollback() is called.
  2. When a SMARTS substructure_match call fails (network error), the whole
     transaction is rolled back and fp_version stays NULL (the PermanentHandlerError
     bubble ensures catch-up retries).
  3. The successful happy path calls commit() exactly once and no rollback.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from services.projectors.common.base import PermanentHandlerError


INCHIKEY = "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"  # aspirin
SMILES = "CC(=O)Oc1ccccc1C(=O)O"


def _fp_response(on_bits: list[int] | None = None, n_bits: int = 2048) -> dict[str, Any]:
    return {"on_bits": on_bits or [0, 1, 2], "n_bits": n_bits}


def _make_fingerprinter() -> Any:
    """Build a CompoundFingerprinter with a mocked HTTP client and no real
    Postgres DSN — only _fingerprint and _post_json are exercised."""
    from services.projectors.compound_fingerprinter.main import (
        CompoundFingerprinter,
        CompoundFingerprinterSettings,
    )
    settings = CompoundFingerprinterSettings(
        postgres_host="localhost",
        postgres_password="fake",
        mcp_rdkit_url="http://mcp-rdkit:8001",
    )
    proj = CompoundFingerprinter(settings)
    return proj


def _make_http_client(
    *,
    fp_status: int = 200,
    smarts_status: int = 200,
    smarts_raises: Exception | None = None,
) -> MagicMock:
    """Return a mock httpx.AsyncClient.

    fp_status: HTTP status returned for /tools/morgan_fingerprint,
               /tools/maccs_fingerprint, /tools/atompair_fingerprint,
               /tools/murcko_scaffold.
    smarts_status: HTTP status returned for /tools/substructure_match.
    smarts_raises: if set, _post_json for substructure_match raises this.
    """
    async def _post(path: str, **kwargs: Any) -> MagicMock:
        resp = MagicMock()
        resp.text = "error body"
        if path == "/tools/substructure_match":
            if smarts_raises is not None:
                raise smarts_raises
            resp.status_code = smarts_status
            resp.json.return_value = {"count": 1}
        else:
            resp.status_code = fp_status
            resp.json.return_value = _fp_response()
        return resp

    client = MagicMock()
    client.post = _post
    return client


def _make_work_conn(rules: list[dict[str, Any]] | None = None) -> AsyncMock:
    """Return a mock psycopg AsyncConnection.

    The cursor context manager yields an AsyncMock cursor. Two execute()
    calls happen in the SMARTS loop: one for catalog SELECT and N for hits.
    fetchall() on that cursor returns the provided rules list.
    """
    if rules is None:
        rules = [{"id": "aaa-bbb-ccc", "smarts": "[OH]"}]

    cursor = AsyncMock()
    cursor.fetchall = AsyncMock(return_value=rules)
    cursor.__aenter__ = AsyncMock(return_value=cursor)
    cursor.__aexit__ = AsyncMock(return_value=None)

    conn = AsyncMock()
    conn.cursor = MagicMock(return_value=cursor)
    conn.commit = AsyncMock()
    conn.rollback = AsyncMock()
    return conn


@pytest.mark.asyncio
async def test_fingerprint_happy_path_commits_once() -> None:
    """Successful fingerprint → commit() called, rollback() not called."""
    proj = _make_fingerprinter()
    proj._http = _make_http_client()
    work_conn = _make_work_conn(rules=[])  # empty catalog → no SMARTS loop

    await proj._fingerprint(work_conn, INCHIKEY, SMILES)

    work_conn.commit.assert_awaited_once()
    work_conn.rollback.assert_not_awaited()


@pytest.mark.asyncio
async def test_fingerprint_error_on_fp_call_raises_and_rolls_back() -> None:
    """mcp-rdkit returns 422 on /tools/morgan_fingerprint → PermanentHandlerError
    is raised and rollback() is called so the transaction is clean for retries.
    _post_json raises for any status >= 400 (4xx and 5xx alike)."""
    proj = _make_fingerprinter()
    proj._http = _make_http_client(fp_status=422)
    work_conn = _make_work_conn()

    with pytest.raises(PermanentHandlerError, match="mcp-rdkit"):
        await proj._fingerprint(work_conn, INCHIKEY, SMILES)

    work_conn.rollback.assert_awaited_once()
    work_conn.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_fingerprint_smarts_http_error_rolls_back() -> None:
    """Network error on /tools/substructure_match → PermanentHandlerError raised,
    transaction rolled back so fp_version stays NULL and catch-up retries."""
    proj = _make_fingerprinter()
    proj._http = _make_http_client(
        smarts_raises=httpx.ConnectError("connection refused"),
    )
    work_conn = _make_work_conn(rules=[{"id": "rule-1", "smarts": "[OH]"}])

    with pytest.raises(PermanentHandlerError, match="SMARTS rules failed"):
        await proj._fingerprint(work_conn, INCHIKEY, SMILES)

    work_conn.rollback.assert_awaited_once()
    work_conn.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_fingerprint_smarts_4xx_rolls_back() -> None:
    """4xx on /tools/substructure_match → same rollback path as network error."""
    proj = _make_fingerprinter()
    proj._http = _make_http_client(smarts_status=400)
    work_conn = _make_work_conn(rules=[{"id": "rule-1", "smarts": "[OH]"}])

    with pytest.raises(PermanentHandlerError, match="SMARTS rules failed"):
        await proj._fingerprint(work_conn, INCHIKEY, SMILES)

    work_conn.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_fingerprint_partial_smarts_failure_rolls_back_all() -> None:
    """Two SMARTS rules; first succeeds (count=1), second fails.
    The transaction is rolled back — no partial commit of the first match."""
    proj = _make_fingerprinter()

    call_count = 0

    async def _post(path: str, **kwargs: Any) -> MagicMock:
        nonlocal call_count
        resp = MagicMock()
        resp.text = "error"
        if path == "/tools/substructure_match":
            call_count += 1
            resp.status_code = 200 if call_count == 1 else 400
            resp.json.return_value = {"count": 1}
        else:
            resp.status_code = 200
            resp.json.return_value = _fp_response()
        return resp

    client = MagicMock()
    client.post = _post
    proj._http = client

    rules = [
        {"id": "rule-a", "smarts": "[OH]"},
        {"id": "rule-b", "smarts": "[NH2]"},
    ]
    work_conn = _make_work_conn(rules=rules)

    with pytest.raises(PermanentHandlerError, match="1 of 2 SMARTS rules failed"):
        await proj._fingerprint(work_conn, INCHIKEY, SMILES)

    work_conn.rollback.assert_awaited_once()
    work_conn.commit.assert_not_awaited()
