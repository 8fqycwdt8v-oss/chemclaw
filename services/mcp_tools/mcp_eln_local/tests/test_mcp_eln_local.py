"""Tests for mcp-eln-local FastAPI app.

The DB layer is fully mocked — no live Postgres required. We swap the
module-level `_acquire` async context manager with a fake that yields
a stub AsyncConnection whose `cursor()` context manager replays canned
rows per query.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any
from unittest import mock
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Stub psycopg async cursor + connection
# ---------------------------------------------------------------------------


class FakeCursor:
    """Async cursor stub. Each call to execute() pops one reply off the
    SHARED queue owned by FakeConn so a sequence of cursors threads through
    the replies in order."""

    def __init__(self, conn: "FakeConn"):
        self._conn = conn
        self._last_rows: Any = None

    async def __aenter__(self) -> "FakeCursor":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        return None

    async def execute(self, _sql: str, _params: dict[str, Any] | None = None) -> None:
        if not self._conn._replies:
            self._last_rows = []
            return
        self._last_rows = self._conn._replies.pop(0)

    async def fetchall(self) -> list[dict[str, Any]]:
        rows = self._last_rows
        if rows is None:
            return []
        if isinstance(rows, list):
            return rows
        return [rows]

    async def fetchone(self) -> dict[str, Any] | None:
        rows = self._last_rows
        if rows is None:
            return None
        if isinstance(rows, list):
            return rows[0] if rows else None
        return rows


class FakeConn:
    closed = False

    def __init__(self, replies: list[Any]):
        self._replies = list(replies)

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)


# ---------------------------------------------------------------------------
# App fixture — patches _acquire to a fresh fake per test
# ---------------------------------------------------------------------------


@pytest.fixture()
def app_module():
    # Disable the lifespan attempt to open a real DB connection by giving
    # the settings a DSN that doesn't contain the dev sentinel password
    # (which would trip the fail-closed safety guard).
    with mock.patch.dict(
        "os.environ",
        {"MOCK_ELN_DSN": "postgresql://test_user:test_pw@localhost:0/none"},
    ):
        from services.mcp_tools.mcp_eln_local import main as m  # noqa: PLC0415
    return m


def _client_with_replies(app_module, replies: list[Any]) -> TestClient:
    fake = FakeConn(replies)

    @asynccontextmanager
    async def _fake_acquire():
        yield fake

    app_module._acquire = _fake_acquire  # type: ignore[assignment]
    # Build a TestClient that does NOT trigger the real lifespan (we don't
    # need it; _acquire is now stubbed). Calling TestClient as a context
    # manager would still run the lifespan; we use it bare so the pool
    # never opens against a real DB.
    return TestClient(app_module.app)


# ---------------------------------------------------------------------------
# Sample row builders
# ---------------------------------------------------------------------------


PROJECT_ID = uuid4()
NOTEBOOK_ID = uuid4()
REACTION_ID = uuid4()
ENTRY_ID = uuid4()
ENTRY_ID_2 = uuid4()
SAMPLE_ID = uuid4()
ATTACHMENT_ID = uuid4()
COMPOUND_ID = uuid4()


def _entry_row(
    entry_id: UUID = ENTRY_ID,
    *,
    modified_at: datetime | None = None,
    title: str = "Amide coupling test",
    project_code: str = "NCE-1234",
    yield_pct: float | None = 87.3,
    entry_shape: str = "mixed",
    data_quality_tier: str = "clean",
    reaction_id: UUID | None = REACTION_ID,
) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    if yield_pct is not None:
        fields = {"results": {"yield_pct": yield_pct}}
    ts = modified_at or datetime(2025, 1, 15, 12, 0, tzinfo=timezone.utc)
    return {
        "id": entry_id,
        "notebook_id": NOTEBOOK_ID,
        "project_id": PROJECT_ID,
        "reaction_id": reaction_id,
        "schema_kind": "ord-v0.3",
        "title": title,
        "author_email": "alice@example.com",
        "signed_by": None,
        "status": "in_progress",
        "entry_shape": entry_shape,
        "data_quality_tier": data_quality_tier,
        "fields_jsonb": fields,
        "freetext": "ran amide coupling, looks clean",
        "freetext_length_chars": 32,
        "created_at": ts,
        "modified_at": ts,
        "signed_at": None,
        "project_code": project_code,
    }


def _reaction_row(
    reaction_id: UUID = REACTION_ID,
    *,
    family: str = "amide_coupling",
    project_code: str = "NCE-1234",
    ofat_count: int = 120,
    mean_yield: float | None = 78.4,
) -> dict[str, Any]:
    return {
        "reaction_id": reaction_id,
        "canonical_smiles_rxn": "CC(=O)O.NC>>CC(=O)NC",
        "family": family,
        "project_id": PROJECT_ID,
        "step_number": 1,
        "ofat_count": ofat_count,
        "mean_yield": mean_yield,
        "last_activity_at": datetime(2025, 2, 1, 9, 0, tzinfo=timezone.utc),
        "project_code": project_code,
    }


def _sample_row(sample_id: UUID = SAMPLE_ID) -> dict[str, Any]:
    return {
        "id": sample_id,
        "entry_id": ENTRY_ID,
        "sample_code": "S-001",
        "compound_id": COMPOUND_ID,
        "amount_mg": 12.4,
        "purity_pct": 98.7,
        "notes": None,
        "created_at": datetime(2025, 1, 15, 13, 0, tzinfo=timezone.utc),
    }


def _attachment_row(att_id: UUID = ATTACHMENT_ID) -> dict[str, Any]:
    return {
        "id": att_id,
        "filename": "spectrum.png",
        "mime_type": "image/png",
        "size_bytes": 12345,
        "description": "HPLC trace",
        "uri": "file:///mnt/eln/spectrum.png",
        "created_at": datetime(2025, 1, 15, 13, 30, tzinfo=timezone.utc),
    }


# ---------------------------------------------------------------------------
# /healthz + /readyz
# ---------------------------------------------------------------------------


def test_healthz(app_module):
    client = _client_with_replies(app_module, [])
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-eln-local"


def test_readyz_ok_when_enabled(app_module):
    app_module.settings.mock_eln_enabled = True
    client = _client_with_replies(app_module, [])
    r = client.get("/readyz")
    assert r.status_code == 200


def test_readyz_degraded_when_disabled(app_module):
    app_module.settings.mock_eln_enabled = False
    client = _client_with_replies(app_module, [])
    r = client.get("/readyz")
    assert r.status_code == 503
    app_module.settings.mock_eln_enabled = True


# ---------------------------------------------------------------------------
# /experiments/query
# ---------------------------------------------------------------------------


def test_experiments_query_happy_path(app_module):
    rows = [_entry_row(), _entry_row(entry_id=ENTRY_ID_2)]
    client = _client_with_replies(app_module, [rows])
    r = client.post(
        "/experiments/query",
        json={"project_code": "NCE-1234", "limit": 10},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["items"]) == 2
    first = body["items"][0]
    assert first["id"] == str(ENTRY_ID)
    assert first["citation_uri"] == f"local-mock-eln://eln/entry/{ENTRY_ID}"
    assert first["valid_until"] is not None
    assert body["next_cursor"] is None


def test_experiments_query_pagination_returns_cursor(app_module):
    # Limit=2 + 3 rows → next_cursor should be set.
    rows = [
        _entry_row(),
        _entry_row(entry_id=ENTRY_ID_2),
        _entry_row(entry_id=uuid4()),
    ]
    client = _client_with_replies(app_module, [rows])
    r = client.post(
        "/experiments/query",
        json={"project_code": "NCE-1234", "limit": 2},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["items"]) == 2
    assert body["next_cursor"] is not None
    assert "|" in body["next_cursor"]


def test_experiments_query_with_cursor_decodes(app_module):
    client = _client_with_replies(app_module, [[]])
    r = client.post(
        "/experiments/query",
        json={
            "project_code": "NCE-1234",
            "cursor": f"2025-01-15T12:00:00+00:00|{ENTRY_ID}",
        },
    )
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_experiments_query_bad_cursor_400(app_module):
    client = _client_with_replies(app_module, [[]])
    r = client.post(
        "/experiments/query",
        json={"project_code": "NCE-1234", "cursor": "not-a-cursor"},
    )
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_input"


def test_experiments_query_invalid_project_code_422(app_module):
    client = _client_with_replies(app_module, [])
    r = client.post(
        "/experiments/query",
        json={"project_code": "BAD CODE!"},
    )
    assert r.status_code == 422


def test_experiments_query_invalid_entry_shape_422(app_module):
    client = _client_with_replies(app_module, [])
    r = client.post(
        "/experiments/query",
        json={"project_code": "NCE-1234", "entry_shape": "invalid"},
    )
    assert r.status_code == 422


def test_experiments_query_filters_pass_through(app_module):
    """Smoke test that since/entry_shape/data_quality_tier round-trip without 400."""
    client = _client_with_replies(app_module, [[_entry_row()]])
    r = client.post(
        "/experiments/query",
        json={
            "project_code": "NCE-1234",
            "since": "2025-01-01T00:00:00Z",
            "entry_shape": "mixed",
            "data_quality_tier": "clean",
            "schema_kind": "ord-v0.3",
            "reaction_id": str(REACTION_ID),
        },
    )
    assert r.status_code == 200
    assert len(r.json()["items"]) == 1


# ---------------------------------------------------------------------------
# /experiments/fetch
# ---------------------------------------------------------------------------


def test_experiments_fetch_happy_path(app_module):
    # Three queries in sequence: entry SELECT → attachments → audit.
    client = _client_with_replies(
        app_module,
        [
            _entry_row(),                  # entry fetch
            [_attachment_row()],           # attachments
            [],                            # audit summary
        ],
    )
    r = client.post(
        "/experiments/fetch",
        json={"entry_id": str(ENTRY_ID)},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == str(ENTRY_ID)
    assert body["citation_uri"].startswith("local-mock-eln://eln/entry/")
    assert len(body["attachments"]) == 1
    assert body["attachments"][0]["filename"] == "spectrum.png"


def test_experiments_fetch_404_when_missing(app_module):
    client = _client_with_replies(app_module, [None])
    r = client.post(
        "/experiments/fetch",
        json={"entry_id": "missing-id"},
    )
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


def test_experiments_fetch_bad_id_422(app_module):
    client = _client_with_replies(app_module, [])
    r = client.post("/experiments/fetch", json={"entry_id": "bad id!"})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# /reactions/query (OFAT-aware view)
# ---------------------------------------------------------------------------


def test_reactions_query_returns_ofat_counts(app_module):
    rows = [
        _reaction_row(ofat_count=200, mean_yield=82.0),
        _reaction_row(reaction_id=uuid4(), ofat_count=50, mean_yield=64.5),
    ]
    client = _client_with_replies(app_module, [rows])
    r = client.post(
        "/reactions/query",
        json={"family": "amide_coupling", "project_code": "NCE-1234"},
    )
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 2
    assert items[0]["ofat_count"] == 200
    assert items[0]["citation_uri"] == f"local-mock-eln://eln/reaction/{REACTION_ID}"


def test_reactions_query_min_ofat_count(app_module):
    client = _client_with_replies(app_module, [[_reaction_row(ofat_count=200)]])
    r = client.post(
        "/reactions/query",
        json={"min_ofat_count": 100},
    )
    assert r.status_code == 200
    assert r.json()["items"][0]["ofat_count"] == 200


# ---------------------------------------------------------------------------
# /reactions/fetch
# ---------------------------------------------------------------------------


def test_reactions_fetch_with_ofat_children(app_module):
    client = _client_with_replies(
        app_module,
        [
            _reaction_row(ofat_count=120),                    # canonical
            [_entry_row(), _entry_row(entry_id=ENTRY_ID_2)],  # children sorted
        ],
    )
    r = client.post(
        "/reactions/fetch",
        json={"reaction_id": str(REACTION_ID), "top_n_ofat": 5},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["reaction_id"] == str(REACTION_ID)
    assert body["ofat_count"] == 120
    assert len(body["ofat_children"]) == 2


def test_reactions_fetch_404(app_module):
    client = _client_with_replies(app_module, [None])
    r = client.post(
        "/reactions/fetch",
        json={"reaction_id": "missing"},
    )
    assert r.status_code == 404


def test_reactions_fetch_no_children_when_top_n_zero(app_module):
    client = _client_with_replies(
        app_module,
        [_reaction_row(ofat_count=10)],  # only canonical query is issued
    )
    r = client.post(
        "/reactions/fetch",
        json={"reaction_id": str(REACTION_ID), "top_n_ofat": 0},
    )
    assert r.status_code == 200
    assert r.json()["ofat_children"] == []


# ---------------------------------------------------------------------------
# /samples/fetch
# ---------------------------------------------------------------------------


def test_samples_fetch_with_results(app_module):
    result_row = {
        "id": uuid4(),
        "method_id": uuid4(),
        "metric": "purity_pct",
        "value_num": 99.1,
        "value_text": None,
        "unit": "%",
        "measured_at": datetime(2025, 1, 16, 10, 0, tzinfo=timezone.utc),
        "metadata": {"instrument": "HPLC-A"},
    }
    client = _client_with_replies(
        app_module,
        [_sample_row(), [result_row]],
    )
    r = client.post(
        "/samples/fetch",
        json={"sample_id": str(SAMPLE_ID)},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == str(SAMPLE_ID)
    assert body["citation_uri"].startswith("local-mock-eln://eln/sample/")
    assert len(body["results"]) == 1
    assert body["results"][0]["metric"] == "purity_pct"


def test_samples_fetch_404(app_module):
    client = _client_with_replies(app_module, [None])
    r = client.post(
        "/samples/fetch",
        json={"sample_id": "missing-id"},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# /attachments/metadata
# ---------------------------------------------------------------------------


def test_attachments_metadata_happy_path(app_module):
    client = _client_with_replies(
        app_module,
        [
            {"exists": 1},                  # existence check
            [_attachment_row()],            # attachments list
        ],
    )
    r = client.post(
        "/attachments/metadata",
        json={"entry_id": str(ENTRY_ID)},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["entry_id"] == str(ENTRY_ID)
    assert len(body["attachments"]) == 1
    assert body["attachments"][0]["mime_type"] == "image/png"


def test_attachments_metadata_404_when_entry_missing(app_module):
    client = _client_with_replies(app_module, [None])
    r = client.post(
        "/attachments/metadata",
        json={"entry_id": "missing-id"},
    )
    assert r.status_code == 404
