"""HTTP route handlers for mcp-eln-local.

The handlers stay focused on orchestration: parse request → build SQL via
``queries`` → execute via ``main._acquire`` → marshal rows via ``models``.

``_acquire`` is looked up dynamically from the parent ``main`` module at
request time (rather than imported eagerly) so the test suite's monkey-
patch of ``app_module._acquire`` is honoured by the live route. See
``tests/test_mcp_eln_local.py:_client_with_replies``.

Split from main.py during PR-7 (Python God-file split).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

import psycopg
from fastapi import Body, FastAPI, HTTPException

from . import models as M  # noqa: N812 — `M` is the project-wide models alias
from . import queries as Q  # noqa: N812 — `Q` is the project-wide queries alias


def _acquire():
    """Resolve the request-scoped DB acquire context manager from main.

    Late binding is required so test monkey-patches of ``main._acquire``
    take effect on the next request.
    """
    from . import main  # noqa: PLC0415 — late import to honour test patches

    return main._acquire()


async def _fetch_attachments(
    conn: psycopg.AsyncConnection, entry_id: str
) -> list[M.Attachment]:
    async with conn.cursor() as cur:
        await cur.execute(Q.ATTACHMENTS_BY_ENTRY_SQL, {"entry_id": entry_id})
        rows = await cur.fetchall()
    return [M.row_to_attachment(r) for r in rows]


async def _fetch_audit_summary(
    conn: psycopg.AsyncConnection, entry_id: str, limit: int = 20
) -> list[M.AuditEntry]:
    async with conn.cursor() as cur:
        await cur.execute(
            Q.AUDIT_SUMMARY_SQL, {"entry_id": entry_id, "limit": limit}
        )
        rows = await cur.fetchall()
    return [M.row_to_audit(r) for r in rows]


def register_routes(app: FastAPI, settings) -> None:
    """Attach every endpoint to ``app``. Called from ``main.py`` after the
    FastAPI app is built via ``common.app.create_app``."""

    @app.post(
        "/experiments/query", response_model=M.ExperimentsQueryOut, tags=["eln"]
    )
    async def experiments_query(
        req: Annotated[M.ExperimentsQueryIn, Body(...)],
    ) -> M.ExperimentsQueryOut:
        since_dt = M._parse_iso(req.since, "since")
        cursor_ts: datetime | None = None
        cursor_id: str | None = None
        if req.cursor:
            cursor_ts, cursor_id = M.decode_cursor(req.cursor)

        sql, params = Q.build_experiments_query(req, cursor_ts, cursor_id, since_dt)

        async with _acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                rows = await cur.fetchall()

        items = [
            M.row_to_entry(r, settings.valid_until_days) for r in rows[: req.limit]
        ]
        next_cursor: str | None = None
        if len(rows) > req.limit and items:
            last = items[-1]
            next_cursor = M.encode_cursor(last.modified_at, last.id)

        return M.ExperimentsQueryOut(items=items, next_cursor=next_cursor)

    @app.post("/experiments/fetch", response_model=M.ElnEntry, tags=["eln"])
    async def experiments_fetch(
        req: Annotated[M.ExperimentsFetchIn, Body(...)],
    ) -> M.ElnEntry:
        async with _acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    Q.EXPERIMENTS_FETCH_SQL, {"entry_id": req.entry_id}
                )
                row = await cur.fetchone()

            if row is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "not_found",
                        "detail": f"entry {req.entry_id!r} not found",
                    },
                )
            entry = M.row_to_entry(row, settings.valid_until_days)
            entry.attachments = await _fetch_attachments(conn, entry.id)
            entry.audit_summary = await _fetch_audit_summary(conn, entry.id)
            return entry

    @app.post(
        "/reactions/query", response_model=M.ReactionsQueryOut, tags=["eln"]
    )
    async def reactions_query(
        req: Annotated[M.ReactionsQueryIn, Body(...)],
    ) -> M.ReactionsQueryOut:
        sql, params = Q.build_reactions_query(req)
        async with _acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                rows = await cur.fetchall()
        return M.ReactionsQueryOut(
            items=[
                M.row_to_canonical_reaction(r, settings.valid_until_days)
                for r in rows
            ]
        )

    @app.post(
        "/reactions/fetch",
        response_model=M.CanonicalReactionDetail,
        tags=["eln"],
    )
    async def reactions_fetch(
        req: Annotated[M.ReactionsFetchIn, Body(...)],
    ) -> M.CanonicalReactionDetail:
        async with _acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    Q.REACTIONS_FETCH_SQL, {"reaction_id": req.reaction_id}
                )
                row = await cur.fetchone()

            if row is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "not_found",
                        "detail": f"reaction {req.reaction_id!r} not found",
                    },
                )
            canonical = M.row_to_canonical_reaction(row, settings.valid_until_days)

            children: list[M.ElnEntry] = []
            if req.top_n_ofat > 0:
                async with conn.cursor() as cur:
                    await cur.execute(
                        Q.OFAT_CHILDREN_SQL,
                        {
                            "reaction_id": req.reaction_id,
                            "limit": req.top_n_ofat,
                        },
                    )
                    child_rows = await cur.fetchall()
                children = [
                    M.row_to_entry(r, settings.valid_until_days) for r in child_rows
                ]

            return M.CanonicalReactionDetail(
                **canonical.model_dump(),
                ofat_children=children,
            )

    @app.post("/samples/fetch", response_model=M.Sample, tags=["eln"])
    async def samples_fetch(
        req: Annotated[M.SamplesFetchIn, Body(...)],
    ) -> M.Sample:
        async with _acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(Q.SAMPLE_BY_ID_SQL, {"sample_id": req.sample_id})
                row = await cur.fetchone()

            if row is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "not_found",
                        "detail": f"sample {req.sample_id!r} not found",
                    },
                )
            sample = M.row_to_sample(row, settings.valid_until_days)

            async with conn.cursor() as cur:
                await cur.execute(
                    Q.RESULTS_BY_SAMPLE_SQL, {"sample_id": sample.id}
                )
                result_rows = await cur.fetchall()
            sample.results = [M.row_to_result(r) for r in result_rows]
            return sample

    @app.post(
        "/attachments/metadata",
        response_model=M.AttachmentsMetadataOut,
        tags=["eln"],
    )
    async def attachments_metadata(
        req: Annotated[M.AttachmentsMetadataIn, Body(...)],
    ) -> M.AttachmentsMetadataOut:
        async with _acquire() as conn:
            # Verify the entry exists so we return 404 (not an empty list) for an
            # unknown id — keeps cache invalidation semantics tidy.
            async with conn.cursor() as cur:
                await cur.execute(Q.ENTRY_EXISTS_SQL, {"entry_id": req.entry_id})
                exists = await cur.fetchone()
            if exists is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "not_found",
                        "detail": f"entry {req.entry_id!r} not found",
                    },
                )
            attachments = await _fetch_attachments(conn, req.entry_id)
            return M.AttachmentsMetadataOut(
                entry_id=req.entry_id, attachments=attachments
            )

    @app.post(
        "/samples/by_entry", response_model=M.SamplesByEntryOut, tags=["eln"]
    )
    async def samples_by_entry(
        req: Annotated[M.SamplesByEntryIn, Body(...)],
    ) -> M.SamplesByEntryOut:
        """Return all samples linked to one ELN entry.

        The cross-source path (ELN entry → samples → fake_logs.datasets) was
        blocked without this endpoint: clients had to know sample IDs upfront.
        Now `query_eln_canonical_reactions` → `fetch_eln_canonical_reaction`
        (gives entry IDs) → `query_eln_samples_by_entry` (gives sample codes)
        → `query_instrument_datasets` (cross-source linkage by sample_id)
        works end to end.
        """
        async with _acquire() as conn:
            # 404 on unknown entry — same idiom as /attachments/metadata so
            # downstream cache layers can distinguish "no samples" from "no entry".
            async with conn.cursor() as cur:
                await cur.execute(Q.ENTRY_EXISTS_SQL, {"entry_id": req.entry_id})
                exists = await cur.fetchone()
            if exists is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "not_found",
                        "detail": f"entry {req.entry_id!r} not found",
                    },
                )
            async with conn.cursor() as cur:
                await cur.execute(
                    Q.SAMPLES_BY_ENTRY_SQL, {"entry_id": req.entry_id}
                )
                sample_rows = await cur.fetchall()
            samples = [
                M.row_to_sample(r, settings.valid_until_days) for r in sample_rows
            ]
            return M.SamplesByEntryOut(entry_id=req.entry_id, samples=samples)
