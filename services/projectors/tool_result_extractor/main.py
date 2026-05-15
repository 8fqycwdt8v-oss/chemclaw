"""Universal Knowledge Accumulation — Phase 0
tool_result_extractor projector.

Subscribes to `ingestion_events` with `event_type='tool_invocation_complete'`.
For each event:

  1. Look up (source_kind='mcp_tool', source_name=tool_name, result_schema_id)
     in `extraction_registry`.
  2. On registry miss → no-op (expected before Phase 1).
  3. On registry hit (enabled + (promote_default OR explicit promote)) →
     dynamically import the extractor_module and call
     `extract(result, ctx) -> list[FactDraft]`.
  4. INSERT each FactDraft into the `facts` table.
  5. Emit one `extracted_fact` ingestion event per inserted fact.

All step (3)–(5) DB work happens inside a single async connection. A crash
mid-dispatch leaves the event un-acked (per `BaseProjector._process_row`)
so it retries cleanly on the next NOTIFY.

Phase 0 ships with NO registered extractors. The registry is empty and
every event acks as a no-op until Phase 1+ rows are seeded. This keeps the
projector wired (so the operator can verify the LISTEN/NOTIFY plumbing end
to end) without emitting any speculative facts.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings
from services.projectors.tool_result_extractor import extractor_loader

log = logging.getLogger("projector.tool_result_extractor")


@dataclass
class ExtractionContext:
    """Per-invocation context passed to every extractor module."""

    tool_name: str
    user_entra_id: str
    project_id: str | None
    args: dict[str, Any]
    invocation_id: str
    duration_ms: int


@dataclass
class FactDraft:
    """A single fact the extractor wants written to the `facts` table.

    Required fields come first (dataclass default-ordering rule).
    Defaults match the `facts` table CHECK constraints:
      - polarity defaults to 'positive'
      - derivation_depth defaults to 0
      - source_fact_ids defaults to empty list (only set by ABSTRACTED facts)
    """

    subject_label: str
    subject_id_value: str
    predicate: str
    # derivation_class ∈ {OBSERVED, COMPUTED, INTERPRETED, HYPOTHESIZED, ABSTRACTED}
    derivation_class: str
    confidence: float
    # confidence_tier ∈ {foundational, high, medium, low, exploratory}
    confidence_tier: str
    extractor_name: str
    object_label: str | None = None
    object_id_value: str | None = None
    object_value: dict[str, Any] | None = None
    unit: str | None = None
    polarity: str = "positive"
    source_table: str | None = None
    source_row_id: str | None = None
    source_fact_ids: list[UUID] = field(default_factory=list)
    derivation_depth: int = 0


class ToolResultExtractor(BaseProjector):
    """Projector: dispatch tool_invocation_complete → extractor → facts."""

    name = "tool_result_extractor"
    interested_event_types = ("tool_invocation_complete",)

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,  # noqa: ARG002 — filtered upstream by base class
        source_table: str | None,  # noqa: ARG002 — payload carries everything we need
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        # --- gate on payload shape (cheap; no DB) ---------------------------
        tool_name = payload.get("tool_name")
        if not tool_name:
            log.warning(
                "tool_invocation_complete event %s has no tool_name; skipping",
                event_id,
            )
            return

        if not payload.get("ok", True):
            log.debug(
                "tool_invocation_complete %s ok=false; deferred to Phase 1",
                event_id,
            )
            return

        result_schema_id = payload.get("result_schema_id")

        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn, row_factory=dict_row
        ) as conn:
            await self._project(
                conn=conn,
                event_id=event_id,
                source_row_id=source_row_id or "",
                tool_name=str(tool_name),
                result_schema_id=result_schema_id,
                payload=payload,
            )
            await conn.commit()

    # ------------------------------------------------------------------
    # Internal — separated so the unit tests can exercise the dispatch
    # path with a mock connection without monkey-patching psycopg.
    # ------------------------------------------------------------------
    async def _project(
        self,
        *,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        event_id: str,
        source_row_id: str,
        tool_name: str,
        result_schema_id: Any,
        payload: dict[str, Any],
    ) -> None:
        # --- registry lookup ------------------------------------------------
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT extractor_module, enabled, promote_default "
                "FROM extraction_registry "
                "WHERE source_kind=%s AND source_name=%s "
                "  AND result_schema_id IS NOT DISTINCT FROM %s",
                ("mcp_tool", tool_name, result_schema_id),
            )
            row = await cur.fetchone()

        if row is None:
            log.debug(
                "no extractor registered for %s:%s; skipping",
                tool_name, result_schema_id,
            )
            return

        # row may come back as a dict (dict_row factory) or a tuple
        # (test-injected MagicMock returns whatever the test pushed).
        extractor_module, enabled, promote_default = _row_triple(row)

        if not enabled:
            log.debug("extractor for %s is disabled; skipping", tool_name)
            return

        promote = bool(promote_default) or bool(
            (payload.get("args") or {}).get("promote_to_kg", False)
        )
        if not promote:
            log.debug(
                "extractor for %s is registered but promote=false; skipping",
                tool_name,
            )
            return

        # --- import the extractor module -----------------------------------
        try:
            module = extractor_loader.load_extractor(extractor_module)
        except Exception as exc:  # noqa: BLE001 — extractor faults must NOT crash projector
            log.warning(
                "failed to load extractor %s for %s: %s",
                extractor_module, tool_name, exc,
            )
            return

        # --- build the ExtractionContext -----------------------------------
        ctx = ExtractionContext(
            tool_name=tool_name,
            user_entra_id=str(payload.get("user_entra_id", "")),
            project_id=payload.get("project_id"),
            args=payload.get("args") or {},
            invocation_id=source_row_id,
            duration_ms=int(payload.get("duration_ms", 0) or 0),
        )

        # --- run the extractor ---------------------------------------------
        try:
            facts: list[FactDraft] = module.extract(payload.get("result") or {}, ctx)
        except Exception as exc:  # noqa: BLE001 — extractor faults must NOT crash projector
            log.warning(
                "extractor %s raised on tool=%s event=%s: %s",
                extractor_module, tool_name, event_id, exc,
            )
            return

        if not facts:
            log.debug(
                "extractor %s returned 0 facts for tool=%s event=%s",
                extractor_module, tool_name, event_id,
            )
            return

        # --- INSERT each FactDraft + emit `extracted_fact` event -----------
        async with conn.cursor() as cur:
            for fact in facts:
                await cur.execute(
                    """
                    INSERT INTO facts (
                      project_id, subject_label, subject_id_value, predicate,
                      object_label, object_id_value, object_value, unit,
                      polarity, derivation_class, confidence, confidence_tier,
                      source_table, source_row_id, source_fact_ids,
                      extractor_name, derivation_depth
                    ) VALUES (
                      %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s,
                      %s, %s, %s, %s, %s
                    )
                    RETURNING id
                    """,
                    (
                        ctx.project_id,
                        fact.subject_label,
                        fact.subject_id_value,
                        fact.predicate,
                        fact.object_label,
                        fact.object_id_value,
                        json.dumps(fact.object_value)
                        if fact.object_value is not None
                        else None,
                        fact.unit,
                        fact.polarity,
                        fact.derivation_class,
                        float(fact.confidence),
                        fact.confidence_tier,
                        fact.source_table or "tool_invocations",
                        fact.source_row_id or source_row_id,
                        list(fact.source_fact_ids),
                        fact.extractor_name,
                        int(fact.derivation_depth),
                    ),
                )
                returned = await cur.fetchone()
                new_fact_id = _scalar_id(returned)
                await cur.execute(
                    """
                    INSERT INTO ingestion_events
                      (event_type, source_table, source_row_id, payload)
                    VALUES ('extracted_fact', 'facts', %s,
                            jsonb_build_object(
                              'fact_id', %s::text,
                              'extractor', %s::text,
                              'derivation_class', %s::text,
                              'predicate', %s::text
                            ))
                    """,
                    (
                        str(new_fact_id),
                        str(new_fact_id),
                        fact.extractor_name,
                        fact.derivation_class,
                        fact.predicate,
                    ),
                )


def _row_triple(row: Any) -> tuple[str, bool, bool]:
    """Normalise a registry row (dict_row OR tuple) to (module, enabled, promote_default)."""
    if isinstance(row, dict):
        return (
            str(row["extractor_module"]),
            bool(row["enabled"]),
            bool(row["promote_default"]),
        )
    # tuple / list / MagicMock indexable
    return (str(row[0]), bool(row[1]), bool(row[2]))


def _scalar_id(row: Any) -> Any:
    """Extract the RETURNING id from a fetchone() result."""
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get("id")
    return row[0]


def main() -> None:  # pragma: no cover — process entrypoint
    settings = ProjectorSettings()
    configure_logging(settings.projector_log_level)
    asyncio.run(ToolResultExtractor(settings).run())


if __name__ == "__main__":  # pragma: no cover
    main()
