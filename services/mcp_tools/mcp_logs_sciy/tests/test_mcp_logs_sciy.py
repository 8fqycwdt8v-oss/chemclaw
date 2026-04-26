"""Tests for mcp-logs-sciy.

The fake-postgres backend is replaced with an in-memory stub that mimics
the async surface of ``FakePostgresBackend`` so the FastAPI app can be
exercised without a live Postgres instance. A separate test asserts the
real backend stub raises ``NotImplementedError``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.mcp_logs_sciy.backends.real_logs_sdk import RealLogsBackend


# ---------------------------------------------------------------------------
# In-memory stand-in for FakePostgresBackend.
# ---------------------------------------------------------------------------
def _make_dataset(
    uid: str,
    *,
    instrument_kind: str = "HPLC",
    sample_id: str | None = "S-NCE-1234-00001",
    sample_name: str | None = "lot-001",
    project_code: str | None = "NCE-1234",
    measured_at: datetime | None = None,
) -> dict[str, Any]:
    return {
        "backend": "fake-postgres",
        "uid": uid,
        "name": f"run-{uid}",
        "instrument_kind": instrument_kind,
        "instrument_serial": "SERIAL-1",
        "method_name": "method-A",
        "sample_id": sample_id,
        "sample_name": sample_name,
        "operator": "alice",
        "measured_at": (
            measured_at or datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc)
        ).isoformat(),
        "parameters": {"flow_rate_ml_min": 1.0},
        "tracks": [
            {
                "track_index": 0,
                "detector": "UV",
                "unit": "mAU",
                "peaks": [{"rt_min": 1.23, "area": 45.6}],
            }
        ],
        "project_code": project_code,
        "citation_uri": f"local-mock-logs://logs/dataset/{uid}",
    }


def _valid_until() -> str:
    return (datetime.now(tz=timezone.utc) + timedelta(days=7)).isoformat()


class StubBackend:
    """Minimal in-memory backend used by the FastAPI app under test."""

    def __init__(self, datasets: list[dict[str, Any]] | None = None) -> None:
        self._datasets: list[dict[str, Any]] = datasets or []

    async def ready(self) -> bool:
        return True

    async def query_datasets(
        self,
        *,
        instrument_kind: list[str] | None = None,
        since: datetime | None = None,
        project_code: str | None = None,
        sample_name: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        rows = list(self._datasets)
        if instrument_kind:
            rows = [r for r in rows if r["instrument_kind"] in instrument_kind]
        if project_code:
            rows = [r for r in rows if r.get("project_code") == project_code]
        if sample_name:
            needle = sample_name.lower()
            rows = [
                r
                for r in rows
                if r.get("sample_name") and needle in r["sample_name"].lower()
            ]
        return {
            "datasets": rows[:limit],
            "next_cursor": None,
            "valid_until": _valid_until(),
        }

    async def fetch_dataset(self, *, uid: str) -> dict[str, Any]:
        for r in self._datasets:
            if r["uid"] == uid:
                return {"dataset": r, "valid_until": _valid_until()}
        return {"dataset": None, "valid_until": _valid_until()}

    async def fetch_by_sample(self, *, sample_id: str) -> dict[str, Any]:
        return {
            "datasets": [r for r in self._datasets if r.get("sample_id") == sample_id],
            "valid_until": _valid_until(),
        }

    async def query_persons(
        self,
        *,
        name_contains: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        all_persons = [
            {"username": "alice", "display_name": "Alice Adams", "email": "a@x.com"},
            {"username": "bob", "display_name": "Bob Brown", "email": "b@x.com"},
        ]
        if name_contains:
            needle = name_contains.lower()
            all_persons = [
                p
                for p in all_persons
                if needle in p["username"].lower()
                or needle in (p.get("display_name") or "").lower()
            ]
        return {"persons": all_persons[:limit], "valid_until": _valid_until()}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def datasets() -> list[dict[str, Any]]:
    return [
        _make_dataset(
            "ds-001",
            instrument_kind="HPLC",
            sample_id="S-NCE-1234-00001",
            measured_at=datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc),
        ),
        _make_dataset(
            "ds-002",
            instrument_kind="NMR",
            sample_id="S-NCE-1234-00001",
            measured_at=datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc),
        ),
        _make_dataset(
            "ds-003",
            instrument_kind="MS",
            sample_id="S-NCE-1234-00002",
            sample_name="lot-002",
            project_code="NCE-5678",
            measured_at=datetime(2026, 4, 3, 12, 0, tzinfo=timezone.utc),
        ),
    ]


@pytest.fixture()
def client(datasets, monkeypatch):
    from services.mcp_tools.mcp_logs_sciy import main as logs_main

    backend = StubBackend(datasets)
    # Replace the backend factory so the lifespan installs our stub instead
    # of touching Postgres.
    monkeypatch.setattr(logs_main, "_build_backend", lambda: backend)
    with TestClient(logs_main.app) as c:
        yield c


# ---------------------------------------------------------------------------
# /healthz, /readyz
# ---------------------------------------------------------------------------
def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "mcp-logs-sciy"


def test_readyz_ok_when_backend_ready(client):
    r = client.get("/readyz")
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# /datasets/query
# ---------------------------------------------------------------------------
def test_datasets_query_returns_all_when_no_filter(client):
    r = client.post("/datasets/query", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["datasets"]) == 3
    assert body["datasets"][0]["citation_uri"].startswith("local-mock-logs://logs/dataset/")
    assert body["valid_until"]


def test_datasets_query_filters_by_instrument_kind(client):
    r = client.post("/datasets/query", json={"instrument_kind": ["HPLC", "MS"]})
    assert r.status_code == 200
    body = r.json()
    kinds = sorted(d["instrument_kind"] for d in body["datasets"])
    assert kinds == ["HPLC", "MS"]


def test_datasets_query_filters_by_project_code(client):
    r = client.post("/datasets/query", json={"project_code": "NCE-1234"})
    assert r.status_code == 200
    body = r.json()
    assert all(d["project_code"] == "NCE-1234" for d in body["datasets"])


def test_datasets_query_rejects_bad_project_code(client):
    r = client.post("/datasets/query", json={"project_code": "robert; DROP TABLE"})
    assert r.status_code == 422


def test_datasets_query_rejects_invalid_limit(client):
    r = client.post("/datasets/query", json={"limit": 999})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# /datasets/fetch
# ---------------------------------------------------------------------------
def test_datasets_fetch_known_uid(client):
    r = client.post("/datasets/fetch", json={"uid": "ds-001"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dataset"]["uid"] == "ds-001"
    assert body["dataset"]["citation_uri"] == "local-mock-logs://logs/dataset/ds-001"


def test_datasets_fetch_unknown_uid_404(client):
    r = client.post("/datasets/fetch", json={"uid": "ds-missing"})
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


def test_datasets_fetch_rejects_bad_uid(client):
    r = client.post("/datasets/fetch", json={"uid": "not legal id with spaces"})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# /datasets/by_sample
# ---------------------------------------------------------------------------
def test_datasets_by_sample_returns_matching(client):
    r = client.post("/datasets/by_sample", json={"sample_id": "S-NCE-1234-00001"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["datasets"]) == 2
    assert {d["uid"] for d in body["datasets"]} == {"ds-001", "ds-002"}


def test_datasets_by_sample_returns_empty_for_unknown(client):
    r = client.post("/datasets/by_sample", json={"sample_id": "S-NONE"})
    assert r.status_code == 200
    assert r.json()["datasets"] == []


# ---------------------------------------------------------------------------
# /persons/query
# ---------------------------------------------------------------------------
def test_persons_query_returns_all_when_no_filter(client):
    r = client.post("/persons/query", json={"limit": 10})
    assert r.status_code == 200
    assert len(r.json()["persons"]) == 2


def test_persons_query_filters_by_name_contains(client):
    r = client.post("/persons/query", json={"name_contains": "alice", "limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert len(body["persons"]) == 1
    assert body["persons"][0]["username"] == "alice"


# ---------------------------------------------------------------------------
# Real backend stub
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_real_backend_raises_not_implemented():
    backend = RealLogsBackend(tenant_url="https://example.logs-sciy.com")
    import pytest as _pytest

    with _pytest.raises(NotImplementedError, match="logs-python"):
        await backend.fetch_dataset(uid="anything")
