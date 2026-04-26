"""Fake-Postgres backend for ``mcp-logs-sciy``.

Reads the local ``fake_logs`` schema seeded by ``db/seed/21_fake_logs_data.sql``
and surfaces datasets / tracks / persons in the canonical LOGS shape.

Keyset pagination on ``(measured_at DESC, uid)`` — the cursor encodes both
columns so subsequent pages avoid the OFFSET tax and stay deterministic
even when measurements share a timestamp.
"""

from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger("mcp.logs_sciy.fake_postgres")

# Citation URI template — must round-trip through the post-tool source-cache
# hook unchanged. ``{uid}`` is filled in per dataset.
FAKE_CITATION_URI_TEMPLATE = "local-mock-logs://logs/dataset/{uid}"

# Default TTL for cached source facts. Must match plan §"Source-cache + KG
# projector" (7 days) so the kg_source_cache projector's freshness window is
# consistent across MCPs.
DEFAULT_VALID_UNTIL_DAYS = 7


def _encode_cursor(measured_at: datetime, uid: str) -> str:
    payload = {"m": measured_at.isoformat(), "u": uid}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii"))
        payload = json.loads(raw.decode("utf-8"))
        return datetime.fromisoformat(payload["m"]), str(payload["u"])
    except (ValueError, KeyError, TypeError) as exc:
        # Bubble up as ValueError so create_app's handler maps it to 400.
        raise ValueError(f"invalid cursor: {exc}") from exc


def _valid_until_iso() -> str:
    return (
        datetime.now(tz=timezone.utc) + timedelta(days=DEFAULT_VALID_UNTIL_DAYS)
    ).isoformat()


def _row_to_dataset(row: dict[str, Any], tracks: list[dict[str, Any]]) -> dict[str, Any]:
    measured_at = row["measured_at"]
    if isinstance(measured_at, datetime):
        measured_at_iso = measured_at.isoformat()
    else:
        measured_at_iso = str(measured_at)
    uid = row["uid"]
    citation_uri = row.get("citation_uri") or FAKE_CITATION_URI_TEMPLATE.format(uid=uid)
    return {
        "backend": "fake-postgres",
        "uid": uid,
        "name": row["name"],
        "instrument_kind": row["instrument_kind"],
        "instrument_serial": row.get("instrument_serial"),
        "method_name": row.get("method_name"),
        "sample_id": row.get("sample_id"),
        "sample_name": row.get("sample_name"),
        "operator": row.get("operator"),
        "measured_at": measured_at_iso,
        "parameters": row.get("parameters_jsonb") or {},
        "tracks": tracks,
        "project_code": row.get("project_code"),
        "citation_uri": citation_uri,
    }


def _row_to_track(row: dict[str, Any]) -> dict[str, Any]:
    peaks = row.get("peaks_jsonb") or []
    return {
        "track_index": row["track_index"],
        "detector": row.get("detector"),
        "unit": row.get("unit"),
        "peaks": peaks,
    }


def _row_to_person(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "username": row["username"],
        "display_name": row.get("display_name"),
        "email": row.get("email"),
    }


class FakePostgresBackend:
    """Async psycopg backend reading the ``fake_logs`` schema."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    async def _connect(self) -> psycopg.AsyncConnection:
        return await psycopg.AsyncConnection.connect(
            self._dsn, autocommit=True, row_factory=dict_row
        )

    async def ready(self) -> bool:
        try:
            async with await self._connect() as conn:
                async with conn.cursor() as cur:
                    await cur.execute("SELECT 1 FROM fake_logs.datasets LIMIT 1")
                    await cur.fetchone()
            return True
        except Exception as exc:  # noqa: BLE001 — readyz returns 503 on any failure
            log.warning("fake-postgres ready-check failed: %s", exc)
            return False

    async def _fetch_tracks_for(
        self, conn: psycopg.AsyncConnection, uids: list[str]
    ) -> dict[str, list[dict[str, Any]]]:
        if not uids:
            return {}
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT dataset_uid, track_index, detector, unit, peaks_jsonb
                  FROM fake_logs.tracks
                 WHERE dataset_uid = ANY(%s)
                 ORDER BY dataset_uid, track_index
                """,
                (uids,),
            )
            rows = await cur.fetchall()
        out: dict[str, list[dict[str, Any]]] = {}
        for r in rows:
            out.setdefault(r["dataset_uid"], []).append(_row_to_track(r))
        return out

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
        # Build a parameterised WHERE clause defensively — every fragment
        # uses placeholders, never string interpolation, so callers can't
        # smuggle SQL through any of the filter inputs.
        clauses: list[str] = []
        params: list[Any] = []
        if instrument_kind:
            clauses.append("instrument_kind = ANY(%s)")
            params.append(instrument_kind)
        if since is not None:
            clauses.append("measured_at >= %s")
            params.append(since)
        if project_code is not None:
            clauses.append("project_code = %s")
            params.append(project_code)
        if sample_name is not None:
            # Partial-match per the plan; ILIKE keeps it case-insensitive.
            # Escape user-provided wildcard characters so a chemist who
            # writes "%" or "_" in a sample name doesn't trigger a global
            # scan.
            escaped = (
                sample_name.replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            )
            clauses.append("sample_name ILIKE %s ESCAPE %s")
            params.append(f"%{escaped}%")
            params.append("\\")
        if cursor is not None:
            cursor_measured_at, cursor_uid = _decode_cursor(cursor)
            # Keyset on (measured_at DESC, uid DESC). Tuple `<` is correct
            # for DESC/DESC: row comes "after" the cursor when its
            # (measured_at, uid) sorts strictly less than the cursor's pair.
            # An earlier version used `uid ASC` here, which made this
            # predicate skip/duplicate rows when measured_at tied between
            # consecutive datasets.
            clauses.append("(measured_at, uid) < (%s, %s)")
            params.append(cursor_measured_at)
            params.append(cursor_uid)

        where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        # Fetch limit + 1 so we can tell whether another page exists without
        # a separate COUNT query.
        sql = f"""
            SELECT uid, name, instrument_kind, instrument_serial, method_name,
                   sample_id, sample_name, operator, measured_at,
                   parameters_jsonb, project_code, citation_uri
              FROM fake_logs.datasets
            {where_sql}
             ORDER BY measured_at DESC, uid DESC
             LIMIT %s
        """
        params.append(limit + 1)

        async with await self._connect() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                rows = await cur.fetchall()

            has_more = len(rows) > limit
            page = rows[:limit]
            uids = [r["uid"] for r in page]
            tracks_by_uid = await self._fetch_tracks_for(conn, uids)

        datasets = [_row_to_dataset(r, tracks_by_uid.get(r["uid"], [])) for r in page]
        next_cursor: str | None = None
        if has_more and page:
            last = page[-1]
            next_cursor = _encode_cursor(last["measured_at"], last["uid"])

        return {
            "datasets": datasets,
            "next_cursor": next_cursor,
            "valid_until": _valid_until_iso(),
        }

    async def fetch_dataset(self, *, uid: str) -> dict[str, Any]:
        async with await self._connect() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT uid, name, instrument_kind, instrument_serial, method_name,
                           sample_id, sample_name, operator, measured_at,
                           parameters_jsonb, project_code, citation_uri
                      FROM fake_logs.datasets
                     WHERE uid = %s
                    """,
                    (uid,),
                )
                row = await cur.fetchone()
            if row is None:
                return {"dataset": None, "valid_until": _valid_until_iso()}
            tracks_by_uid = await self._fetch_tracks_for(conn, [uid])

        return {
            "dataset": _row_to_dataset(row, tracks_by_uid.get(uid, [])),
            "valid_until": _valid_until_iso(),
        }

    async def fetch_by_sample(self, *, sample_id: str) -> dict[str, Any]:
        async with await self._connect() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT uid, name, instrument_kind, instrument_serial, method_name,
                           sample_id, sample_name, operator, measured_at,
                           parameters_jsonb, project_code, citation_uri
                      FROM fake_logs.datasets
                     WHERE sample_id = %s
                     ORDER BY measured_at DESC, uid ASC
                    """,
                    (sample_id,),
                )
                rows = await cur.fetchall()
            uids = [r["uid"] for r in rows]
            tracks_by_uid = await self._fetch_tracks_for(conn, uids)

        return {
            "datasets": [_row_to_dataset(r, tracks_by_uid.get(r["uid"], [])) for r in rows],
            "valid_until": _valid_until_iso(),
        }

    async def query_persons(
        self,
        *,
        name_contains: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        clauses: list[str] = []
        params: list[Any] = []
        if name_contains is not None:
            escaped = (
                name_contains.replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            )
            clauses.append(
                "(display_name ILIKE %s ESCAPE %s OR username ILIKE %s ESCAPE %s)"
            )
            params.extend([f"%{escaped}%", "\\", f"%{escaped}%", "\\"])
        where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"""
            SELECT username, display_name, email
              FROM fake_logs.persons
            {where_sql}
             ORDER BY username ASC
             LIMIT %s
        """
        params.append(limit)
        async with await self._connect() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                rows = await cur.fetchall()
        return {
            "persons": [_row_to_person(r) for r in rows],
            "valid_until": _valid_until_iso(),
        }
