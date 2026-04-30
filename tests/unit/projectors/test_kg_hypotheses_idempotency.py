"""Regression test for kg_hypotheses idempotent valid_to handling.

Before the fix, replaying a `hypothesis_status_changed` event for a refuted
hypothesis would advance `h.valid_to` to the current `datetime()` on every
replay — eventually drifting hours or days past the original refutation
moment. The fix wraps the assignment in `CASE WHEN h.valid_to IS NULL ...
ELSE h.valid_to END` so the timestamp is set once and frozen thereafter.

We assert two things without spinning up Neo4j:
  1. The cypher captured by `_handle_status_changed` contains the guard.
  2. Replaying the same event twice issues the same guarded cypher both
     times — which Neo4j will resolve to a no-op on the second pass.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.kg_hypotheses.main import KgHypothesesProjector


class _FakeSession:
    """Captures cypher run() calls for assertion."""

    def __init__(self) -> None:
        self.runs: list[tuple[str, dict[str, Any]]] = []

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    async def run(self, query: str, **params: Any) -> None:
        self.runs.append((query, params))


class _FakeDriver:
    def __init__(self) -> None:
        self.session_obj = _FakeSession()

    def session(self) -> _FakeSession:
        return self.session_obj


@pytest.mark.asyncio
async def test_refuted_status_uses_idempotent_valid_to_guard() -> None:
    """Replaying a refuted-hypothesis event must not advance valid_to."""
    settings = MagicMock()
    settings.postgres_dsn = "postgresql://stub"

    proj = KgHypothesesProjector.__new__(KgHypothesesProjector)
    proj.settings = settings  # type: ignore[attr-defined]
    proj._driver = _FakeDriver()  # type: ignore[attr-defined]

    hid = str(uuid.uuid4())

    # Mock the Postgres status fetch to return 'refuted'.
    fake_cur = AsyncMock()
    fake_cur.execute = AsyncMock()
    fake_cur.fetchone = AsyncMock(return_value=("refuted",))
    fake_cur.__aenter__ = AsyncMock(return_value=fake_cur)
    fake_cur.__aexit__ = AsyncMock(return_value=None)

    fake_conn = MagicMock()
    fake_conn.cursor = MagicMock(return_value=fake_cur)
    fake_conn.__aenter__ = AsyncMock(return_value=fake_conn)
    fake_conn.__aexit__ = AsyncMock(return_value=None)

    async def _connect(_dsn: str) -> Any:
        return fake_conn

    with patch("psycopg.AsyncConnection.connect", side_effect=_connect):
        await proj._handle_status_changed({"hypothesis_id": hid}, hid)
        await proj._handle_status_changed({"hypothesis_id": hid}, hid)

    runs = proj._driver.session_obj.runs  # type: ignore[attr-defined]
    assert len(runs) == 2, "expected one cypher per replay"

    for query, _params in runs:
        assert "CASE WHEN h.valid_to IS NULL" in query, (
            "valid_to must be guarded so replays don't advance the timestamp"
        )
        assert "ELSE h.valid_to END" in query

    # The same cypher both times — Neo4j collapses the second run to a no-op
    # because h.valid_to is now non-null.
    assert runs[0][0] == runs[1][0]
