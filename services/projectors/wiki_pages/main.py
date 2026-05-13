"""wiki_pages — knowledge-wiki projection projector (ADR 012 Phase 2a).

Keeps `knowledge_articles` in sync with "which pages exist and which need
(re)synthesis": on every canonical-knowledge event it ensures the affected
entity has a page (creating a `dirty` stub if missing) and marks existing
pages `dirty` so the regeneration loop (Phase 2b) and the wiki_linter cron
(Phase 4) pick them up. On `fact_invalidated` it walks the citation
reverse-index and marks every page that cited the now-invalidated fact dirty
(`lint:stale_citation`).

This phase does NOT run the LLM body-synthesis loop — that lands in Phase 2b
(`db/init` config knobs + `prompt_registry` `wiki.synthesis` mode + a debounced
regen pass). Until then a `dirty` stub has `body_md = ''`; `read_article`
returns it with `stale: true` and the agent / a human can `request_article` /
PATCH it. Compound and reaction-family auto-stubbing also waits for Phase 2b /
the Phase-4 linter (needs reaction-component derivation) — for now those pages
come from the agent's `request_article` builtin.

Events consumed (all carry source_table + source_row_id pointing at the
canonical row, which we read to derive the affected entity):
  * document_ingested              → document/<sha256-prefix>  (stub)
  * experiment_imported            → project/<internal_id>
  * hypothesis_proposed            → project/<internal_id>     (if scoped)
  * hypothesis_status_changed      → project/<internal_id>     (if scoped)
  * synthesis_campaign_created     → campaign/<uuid> (stub) + project/<internal_id>
  * synthesis_campaign_state_changed → campaign/<uuid> + project/<internal_id>
  * fact_invalidated               → every page citing fact_id (stale_citation)

Idempotency: `_touch_page` is INSERT ... ON CONFLICT (slug) DO UPDATE — a
fresh insert happens once per slug, every later event hits the conflict path
and just (re)marks `dirty`. Replay-safe via `projection_acks`. The
`knowledge_article_created` ingestion event fires once on the fresh insert
(consumed by the Phase-3 wiki_kg / wiki_search_index projectors); marking a
page dirty does NOT change `revision`/`status` so it emits no event.

The projector connects as `chemclaw_service` (BYPASSRLS) per CLAUDE.md, so RLS
does not apply to its writes. Stub pages get `created_by = '__system__'` and
`group_id = '__system__'` — the wiki_kg projector (Phase 3) maps project pages
to their project group_id when it creates the :WikiPage node.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import psycopg
from psycopg.rows import dict_row

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import (
    BaseProjector,
    PermanentHandlerError,
    ProjectorSettings,
)

log = logging.getLogger("projector.wiki_pages")

# How much of a document SHA-256 goes into the page slug. 16 hex chars (64
# bits) is collision-safe for any realistic corpus and keeps the slug short.
_SHA_SLUG_LEN = 16

_SYSTEM = "__system__"


class WikiPagesProjector(BaseProjector):
    name = "wiki_pages"
    interested_event_types = (
        "document_ingested",
        "experiment_imported",
        "hypothesis_proposed",
        "hypothesis_status_changed",
        "synthesis_campaign_created",
        "synthesis_campaign_state_changed",
        "fact_invalidated",
    )

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,  # noqa: ARG002
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn, row_factory=dict_row
        ) as conn:
            if event_type == "document_ingested":
                await self._handle_document(conn, event_id, source_row_id)
            elif event_type == "experiment_imported":
                await self._handle_experiment(conn, event_id, source_row_id)
            elif event_type in ("hypothesis_proposed", "hypothesis_status_changed"):
                await self._handle_hypothesis(conn, event_id, source_row_id, event_type)
            elif event_type in (
                "synthesis_campaign_created",
                "synthesis_campaign_state_changed",
            ):
                await self._handle_campaign(conn, event_id, source_row_id, event_type)
            elif event_type == "fact_invalidated":
                await self._handle_fact_invalidated(conn, event_id, payload)
            await conn.commit()

    # ----- per-event handlers --------------------------------------------

    async def _handle_document(
        self, conn: psycopg.AsyncConnection[dict[str, Any]], event_id: str, doc_id: str | None
    ) -> None:
        if not doc_id:
            return
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT sha256, title FROM documents WHERE id = %s::uuid", (doc_id,)
            )
            row = await cur.fetchone()
        if not row:
            raise PermanentHandlerError(f"document {doc_id} not found (event {event_id})")
        sha: str = row["sha256"]
        title = row.get("title") or f"Document {sha[:8]}"
        await self._touch_page(
            conn,
            slug=f"document/{sha[:_SHA_SLUG_LEN]}",
            kind="document_digest",
            title=str(title),
            entity_ref={"label": "Document", "id_property": "sha256", "id_value": sha},
            nce_project_id=None,
            reason="document_ingested",
        )

    async def _handle_experiment(
        self, conn: psycopg.AsyncConnection[dict[str, Any]], event_id: str, exp_id: str | None
    ) -> None:
        if not exp_id:
            return
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT np.id::text AS project_id, np.internal_id, np.name
                  FROM experiments e
                  JOIN synthetic_steps ss ON ss.id = e.synthetic_step_id
                  JOIN nce_projects np ON np.id = ss.nce_project_id
                 WHERE e.id = %s::uuid
                """,
                (exp_id,),
            )
            row = await cur.fetchone()
        if not row:
            # Experiment / step / project missing — bad data; ack and move on.
            raise PermanentHandlerError(
                f"experiment {exp_id} → project join empty (event {event_id})"
            )
        await self._touch_project_page(conn, row["project_id"], row["internal_id"], row["name"], "experiment_imported")

    async def _handle_hypothesis(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        event_id: str,  # noqa: ARG002
        hyp_id: str | None,
        event_type: str,
    ) -> None:
        if not hyp_id:
            return
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT np.id::text AS project_id, np.internal_id, np.name
                  FROM hypotheses h
                  JOIN nce_projects np ON np.id = h.scope_nce_project_id
                 WHERE h.id = %s::uuid
                """,
                (hyp_id,),
            )
            row = await cur.fetchone()
        if not row:
            # Either the hypothesis is unscoped (no good page slug) or it's
            # gone. Nothing to mark dirty — not an error.
            return
        await self._touch_project_page(conn, row["project_id"], row["internal_id"], row["name"], event_type)

    async def _handle_campaign(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        event_id: str,
        camp_id: str | None,
        event_type: str,
    ) -> None:
        if not camp_id:
            return
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT sc.id::text AS campaign_id, sc.name AS campaign_name, sc.kind,
                       np.id::text AS project_id, np.internal_id, np.name AS project_name
                  FROM synthesis_campaigns sc
                  JOIN nce_projects np ON np.id = sc.nce_project_id
                 WHERE sc.id = %s::uuid
                """,
                (camp_id,),
            )
            row = await cur.fetchone()
        if not row:
            raise PermanentHandlerError(
                f"synthesis_campaign {camp_id} → project join empty (event {event_id})"
            )
        await self._touch_page(
            conn,
            slug=f"campaign/{row['campaign_id']}",
            kind="synthesis_campaign",
            title=str(row["campaign_name"] or f"Campaign {row['campaign_id'][:8]}"),
            entity_ref={
                "label": "SynthesisCampaign",
                "id_property": "id",
                "id_value": row["campaign_id"],
                "campaign_kind": row.get("kind"),
            },
            nce_project_id=row["project_id"],
            reason=event_type,
        )
        await self._touch_project_page(conn, row["project_id"], row["internal_id"], row["project_name"], event_type)

    async def _handle_fact_invalidated(
        self, conn: psycopg.AsyncConnection[dict[str, Any]], event_id: str, payload: dict[str, Any]
    ) -> None:
        fid = payload.get("fact_id")
        if not fid or not isinstance(fid, str):
            return
        reason = f"lint:stale_citation (fact {fid[:8]}…)"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE knowledge_articles
                   SET dirty = true, dirty_reason = %s, updated_at = NOW()
                 WHERE id IN (
                   SELECT DISTINCT article_id
                     FROM knowledge_article_citations
                    WHERE cite_kind = 'fact' AND cite_ref = %s
                 )
                """,
                (reason, fid),
            )
            n = cur.rowcount
        if n:
            log.info("event %s: fact %s invalidated → marked %d page(s) dirty", event_id, fid[:8], n)

    # ----- helpers --------------------------------------------------------

    async def _touch_project_page(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        project_id: str,
        internal_id: str,
        name: str | None,
        reason: str,
    ) -> None:
        await self._touch_page(
            conn,
            slug=f"project/{internal_id}",
            kind="nce_project",
            title=str(name or f"NCE project {internal_id}"),
            entity_ref={"label": "NCEProject", "id_property": "internal_id", "id_value": internal_id},
            nce_project_id=project_id,
            reason=reason,
        )

    async def _touch_page(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        *,
        slug: str,
        kind: str,
        title: str,
        entity_ref: dict[str, Any] | None,
        nce_project_id: str | None,
        reason: str,
    ) -> None:
        """Ensure the page exists (create a dirty stub if not) and mark it dirty.

        Idempotent: fresh INSERT once per slug; every later call hits the
        conflict path and just (re)stamps dirty + dirty_reason + updated_at.
        """
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO knowledge_articles
                  (slug, kind, title, body_md, entity_ref, nce_project_id,
                   group_id, maturity, dirty, dirty_reason, created_by)
                VALUES (%s, %s, %s, '', %s::jsonb, %s::uuid, %s, 'EXPLORATORY', true, %s, %s)
                ON CONFLICT (slug) DO UPDATE SET
                  dirty        = true,
                  dirty_reason = EXCLUDED.dirty_reason,
                  updated_at   = NOW()
                """,
                (
                    slug,
                    kind,
                    title[:400],
                    json.dumps(entity_ref) if entity_ref is not None else None,
                    nce_project_id,
                    _SYSTEM,
                    reason[:200] if reason else None,
                    _SYSTEM,
                ),
            )


def main() -> None:  # pragma: no cover — process entrypoint
    settings = ProjectorSettings()
    configure_logging(settings.projector_log_level, service="wiki_pages")
    proj = WikiPagesProjector(settings)
    asyncio.run(proj.run())


if __name__ == "__main__":
    main()
