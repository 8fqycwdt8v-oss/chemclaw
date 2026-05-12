"""wiki_kg — project knowledge-wiki pages into Neo4j (ADR 012 Phase 3a).

Mirrors each `knowledge_articles` row as a `:WikiPage` node in the KG and
links the page to the facts it grounds — so `query_provenance` (a future
extension) can answer "which page asserts this fact?" and `retrieve_related`
can fan out from an entity to its page. A direct-driver projector (like
`kg_hypotheses` / `kg_documents` / `qm_kg`): it writes `:WikiPage` nodes,
which `mcp-kg`'s `:Fact`-only REST surface doesn't model, via the shared
`services/projectors/common/neo4j_client.py`.

Events consumed: `knowledge_article_created` / `_revised` / `_archived`
(emitted by the trigger on `knowledge_articles` — db/init/58_knowledge_wiki.sql).
For created/revised it reads the page title + the new revision's `fact:`
citations from Postgres, then:

  * MERGEs `(:WikiPage {slug})` — sets/updates title, kind, article_id,
    revision, group_id, recorded_at; clears `archived` (it's a current page).
  * For each `fact:<uuid>` citation that matches an existing `(:Fact {fact_id})`
    node, MERGEs `(:WikiPage)-[:GROUNDS {fact_id: <deterministic>}]->(:Fact)`
    and stamps `cited_at_revision = <new revision>`. Facts dropped from the new
    revision keep `cited_at_revision < new` and get `invalidated_at` set —
    bi-temporal close, idempotent CASE-WHEN guard (à la kg_hypotheses).
  * For entity-backed pages whose label maps to a KG node type the system
    already creates (`Compound {inchikey}`, `NCEProject {internal_id}`,
    `Document {document_id}`), `OPTIONAL MATCH`es that node and MERGEs a
    `(:WikiPage)-[:SUMMARIZES]->(entity)` edge (never creates a stub entity).
    Other labels (SynthesisCampaign, ReactionFamily, Researcher) have no KG
    node yet — skipped (BACKLOG).

For `_archived` it sets `wp.archived = true` and closes the page's live
`:GROUNDS` edges.

Tenant scope: uses `payload.group_id` (today always `__system__`; a
wiki_pages follow-up will tag project pages with the project UUID like
kg_experiments does — see BACKLOG). Idempotent: deterministic UUIDv5 edge
fact_ids + MERGE; replay-safe via `projection_acks`.
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from typing import Any

import psycopg
from psycopg.rows import dict_row

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings
from services.projectors.common.neo4j_client import SYSTEM_GROUP_ID, Neo4jClient

log = logging.getLogger("projector.wiki_kg")

NAMESPACE_GROUNDS = uuid.UUID("9111d5a2-1100-4abc-9a11-9911aabbccdd")

# Defense-in-depth on group_id (Tranche 1 convention): alphanumerics + _ - and
# the bare UUID form a project-scoped page would carry.
_GROUP_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,80}$")

# entity_ref.label → (node label, merge property). Only labels for which the
# KG already creates nodes (so we OPTIONAL MATCH, never stub).
_SUMMARIZES_TARGETS: dict[str, tuple[str, str]] = {
    "Compound": ("Compound", "inchikey"),
    "NCEProject": ("NCEProject", "internal_id"),
    "Document": ("Document", "document_id"),
}


def _deterministic_edge_id(*parts: str) -> str:
    return str(uuid.uuid5(NAMESPACE_GROUNDS, "|".join(parts)))


def _safe_group_id(gid: str | None) -> str:
    gid = gid or SYSTEM_GROUP_ID
    if not _GROUP_ID_RE.fullmatch(gid):
        raise ValueError(f"unsafe group_id: {gid!r}")
    return gid


class WikiKgProjector(BaseProjector):
    name = "wiki_kg"
    interested_event_types = (
        "knowledge_article_created",
        "knowledge_article_revised",
        "knowledge_article_archived",
    )

    def __init__(self, settings: ProjectorSettings) -> None:
        super().__init__(settings)
        self._neo4j = Neo4jClient.from_env()

    async def close(self) -> None:
        await self._neo4j.close()

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,  # noqa: ARG002
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        slug = payload.get("slug")
        article_id = payload.get("article_id") or source_row_id
        if not slug or not article_id:
            log.warning("event %s: missing slug/article_id; acking", event_id)
            return
        group_id = _safe_group_id(payload.get("group_id"))

        if event_type == "knowledge_article_archived":
            async with self._neo4j.session() as sess:
                await sess.run(
                    """
                    MATCH (wp:WikiPage {slug: $slug})
                    SET wp.archived = true, wp.archived_at = datetime()
                    WITH wp
                    MATCH (wp)-[g:GROUNDS]->(:Fact)
                    WHERE g.invalidated_at IS NULL
                    SET g.invalidated_at = datetime(), g.invalidation_reason = 'page_archived'
                    """,
                    slug=slug,
                )
            log.info("event %s: archived WikiPage %s", event_id, slug)
            return

        revision = int(payload.get("revision") or 1)
        entity_ref = payload.get("entity_ref")

        # Read the page title + this revision's fact: citations from Postgres.
        async with await psycopg.AsyncConnection.connect(self.settings.postgres_dsn, row_factory=dict_row) as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT title, kind FROM knowledge_articles WHERE id = %s::uuid", (article_id,))
                row = await cur.fetchone()
            if not row:
                log.warning("event %s: knowledge_articles row %s gone; acking", event_id, article_id)
                return
            title = row["title"]
            kind = payload.get("kind") or row["kind"]
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT DISTINCT cite_ref FROM knowledge_article_citations "
                    "WHERE article_id = %s::uuid AND revision = %s AND cite_kind = 'fact'",
                    (article_id, revision),
                )
                fact_ids = [r["cite_ref"] for r in await cur.fetchall()]

        async with self._neo4j.session() as sess:
            await sess.run(
                """
                MERGE (wp:WikiPage {slug: $slug})
                  ON CREATE SET wp.created_at = datetime()
                SET wp.article_id  = $article_id,
                    wp.title       = $title,
                    wp.kind        = $kind,
                    wp.revision    = $revision,
                    wp.group_id    = $group_id,
                    wp.archived    = false,
                    wp.recorded_at = datetime()
                """,
                slug=slug, article_id=str(article_id), title=title or "", kind=kind,
                revision=revision, group_id=group_id,
            )

            # :SUMMARIZES — link to the backing KG node if one already exists.
            # The MATCH on the entity node returns zero rows when it doesn't
            # exist, so MERGE never runs — no orphan stub. label/prop come
            # from the hardcoded _SUMMARIZES_TARGETS map (not user input).
            if isinstance(entity_ref, dict):
                tgt = _SUMMARIZES_TARGETS.get(str(entity_ref.get("label") or ""))
                idv = entity_ref.get("id_value")
                if tgt and isinstance(idv, str) and idv:
                    node_label, prop = tgt
                    await sess.run(
                        f"""
                        MATCH (wp:WikiPage {{slug: $slug}}), (n:{node_label} {{{prop}: $idv}})
                        MERGE (wp)-[s:SUMMARIZES]->(n)
                          ON CREATE SET s.recorded_at = datetime(), s.group_id = $group_id
                        """,
                        slug=slug, idv=idv, group_id=group_id,
                    )

            # :GROUNDS — one edge per fact this revision cites; only to facts
            # that already exist. Re-citing a fact updates cited_at_revision
            # and resurrects the edge if it had been invalidated; facts dropped
            # from this revision get invalidated_at set below.
            for fid in fact_ids:
                edge_id = _deterministic_edge_id(slug, fid)
                await sess.run(
                    """
                    MATCH (wp:WikiPage {slug: $slug}), (f:Fact {fact_id: $fid})
                    MERGE (wp)-[g:GROUNDS {fact_id: $edge_id}]->(f)
                      ON CREATE SET g.recorded_at = datetime(), g.group_id = $group_id
                    SET g.cited_at_revision = $revision,
                        g.invalidated_at = NULL,
                        g.invalidation_reason = NULL
                    """,
                    slug=slug, fid=fid, edge_id=edge_id, group_id=group_id, revision=revision,
                )
            # Close edges for facts dropped from this revision.
            await sess.run(
                """
                MATCH (wp:WikiPage {slug: $slug})-[g:GROUNDS]->(:Fact)
                WHERE g.cited_at_revision < $revision AND g.invalidated_at IS NULL
                SET g.invalidated_at = datetime(), g.invalidation_reason = 'dropped_from_revision'
                """,
                slug=slug, revision=revision,
            )
        log.info("event %s: projected WikiPage %s (rev %d, %d grounded fact(s))", event_id, slug, revision, len(fact_ids))


def main() -> None:  # pragma: no cover — process entrypoint
    settings = ProjectorSettings()
    configure_logging(settings.projector_log_level, service="wiki_kg")
    proj = WikiKgProjector(settings)
    try:
        asyncio.run(proj.run())
    finally:
        asyncio.run(proj.close())


if __name__ == "__main__":
    main()
