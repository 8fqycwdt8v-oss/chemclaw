"""kg_documents — project ingested documents into Neo4j as :Document + :Chunk nodes.

Tranche 5 / H5 of the KG refactor: the audit found that documents are
ingested + chunks are embedded, but no projector turns them into KG
nodes. Tranche 3's `query_provenance` already returns the per-edge
Provenance JSON, but the architecture's vision of a Fact → Chunk →
Document graph chain wasn't actually wired up. This projector lays the
foundational chain — :Document and :Chunk nodes connected by
:HAS_CHUNK edges — so future work can:

  1. Have structured-extraction layers MERGE :Fact nodes pointing at
     the :Chunk that grounded them.
  2. Have `query_provenance` traverse Fact → DERIVED_FROM → Chunk →
     IN_DOCUMENT → Document end-to-end (the README claims this; it now
     becomes feasible).

Out of scope for Tranche 5: structured fact extraction from chunk text
(ChemDataExtractor / arrow-pushing extraction). That's a separate
project; this projector ships the document-side foundation.

Idempotency: deterministic UUIDv5 fact_ids for the :HAS_CHUNK edges.
Re-applying the projector against the same document is a no-op (MERGE
matches on fact_id).
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import Any

import psycopg
from neo4j import AsyncGraphDatabase

from services.projectors.common.base import BaseProjector, ProjectorSettings


log = logging.getLogger("projector.kg_documents")

NAMESPACE_DOCUMENT = uuid.UUID("d0c5d0c5-d0c5-d0c5-d0c5-d0c5d0c5d0c5")
NAMESPACE_CHUNK = uuid.UUID("ccccdddd-cccc-dddd-cccc-ddddccccdddd")
NAMESPACE_HAS_CHUNK = uuid.UUID("aabbccdd-aabb-ccdd-aabb-ccddaabbccdd")

# Cap chunk text shipped to Neo4j. The full text lives in Postgres
# `document_chunks.text`; the KG node only needs enough for human-readable
# preview / matching by hand. 500 chars matches the citation snippet length
# search_knowledge already uses.
_MAX_CHUNK_TEXT = 500

# Tenant scope. Documents are shared across the org by design today;
# project-scoped documents would land here as `metadata->>'group_id'` once
# upstream ingestion adds that field.
_DEFAULT_GROUP_ID = "__system__"


def _deterministic_fact_id(*parts: str) -> str:
    return str(uuid.uuid5(NAMESPACE_HAS_CHUNK, "|".join(parts)))


class KgDocumentsProjector(BaseProjector):
    name = "kg-documents"
    interested_event_types = ("document_ingested",)

    def __init__(self, settings: ProjectorSettings) -> None:
        super().__init__(settings)
        self._neo4j_uri = os.environ["NEO4J_URI"]
        self._neo4j_user = os.environ.get("NEO4J_USER", "neo4j")
        self._neo4j_password = os.environ["NEO4J_PASSWORD"]
        self._driver = AsyncGraphDatabase.driver(
            self._neo4j_uri, auth=(self._neo4j_user, self._neo4j_password),
        )

    async def close(self) -> None:
        await self._driver.close()

    async def handle(
        self,
        *,
        event_id: str,  # noqa: ARG002
        event_type: str,
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],  # noqa: ARG002
    ) -> None:
        if event_type != "document_ingested":
            return
        if source_table != "documents" or not source_row_id:
            log.warning(
                "document_ingested event missing source_row_id; skipping",
            )
            return

        bundle = await self._load_document_bundle(source_row_id)
        if bundle is None:
            log.warning("document %s not found; skipping", source_row_id)
            return

        # group_id selection: use the document's metadata.group_id when
        # upstream ingestion sets it; otherwise fall back to the system
        # sentinel. Both are bounded by the GroupIdStr regex used elsewhere
        # in the KG (alphanumeric + underscore + hyphen, ≤ 80 chars).
        group_id = _safe_group_id(
            bundle.get("metadata_group_id") or _DEFAULT_GROUP_ID
        )

        doc_fact_id = str(uuid.uuid5(NAMESPACE_DOCUMENT, bundle["id"]))
        async with self._driver.session() as session:
            await session.run(
                """
                MERGE (d:Document {fact_id: $fact_id})
                  ON CREATE SET d.document_id  = $document_id,
                                d.title        = $title,
                                d.source_type  = $source_type,
                                d.ingested_at  = $ingested_at,
                                d.group_id     = $group_id
                """,
                fact_id=doc_fact_id,
                document_id=bundle["id"],
                title=bundle.get("title") or "",
                source_type=bundle["source_type"],
                ingested_at=bundle["ingested_at"],
                group_id=group_id,
            )

            for chunk in bundle["chunks"]:
                chunk_fact_id = str(
                    uuid.uuid5(NAMESPACE_CHUNK, chunk["chunk_id"])
                )
                edge_fact_id = _deterministic_fact_id(
                    "HAS_CHUNK", bundle["id"], chunk["chunk_id"],
                )
                preview = (chunk.get("text") or "")[:_MAX_CHUNK_TEXT]

                await session.run(
                    """
                    MATCH (d:Document {fact_id: $doc_fact_id})
                    MERGE (c:Chunk {fact_id: $chunk_fact_id})
                      ON CREATE SET c.chunk_id     = $chunk_id,
                                    c.heading_path = $heading_path,
                                    c.token_count  = $token_count,
                                    c.preview      = $preview,
                                    c.group_id     = $group_id
                    MERGE (d)-[r:HAS_CHUNK {fact_id: $edge_fact_id}]->(c)
                      ON CREATE SET r.chunk_index = $chunk_index,
                                    r.group_id    = $group_id,
                                    r.created_at  = datetime()
                    """,
                    doc_fact_id=doc_fact_id,
                    chunk_fact_id=chunk_fact_id,
                    chunk_id=chunk["chunk_id"],
                    heading_path=chunk.get("heading_path"),
                    token_count=chunk.get("token_count"),
                    preview=preview,
                    edge_fact_id=edge_fact_id,
                    chunk_index=chunk["chunk_index"],
                    group_id=group_id,
                )
        log.info(
            "projected document %s (%d chunks)",
            source_row_id,
            len(bundle["chunks"]),
        )

    async def _load_document_bundle(self, doc_id: str) -> dict[str, Any] | None:
        """Read the document + its chunks from Postgres in a single tx.

        Bypasses RLS via SET LOCAL ROLE chemclaw_service (same pattern as
        kg_experiments / kg_hypotheses); the projector is a system worker
        and needs cross-project visibility to project a document. Tenant
        scope is re-asserted on the way out via the group_id property on
        every Neo4j node + edge it writes.
        """
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn
        ) as conn, conn.cursor() as cur:
            await cur.execute("SET LOCAL ROLE chemclaw_service")
            await cur.execute(
                """
                SELECT id::text                AS id,
                       title                   AS title,
                       source_type             AS source_type,
                       ingested_at             AS ingested_at,
                       (metadata->>'group_id') AS metadata_group_id
                  FROM documents
                 WHERE id = %s::uuid
                """,
                (doc_id,),
            )
            row = await cur.fetchone()
            if row is None:
                return None
            doc = {
                "id": row[0],
                "title": row[1],
                "source_type": row[2],
                "ingested_at": row[3].isoformat()
                    if hasattr(row[3], "isoformat") else str(row[3]),
                "metadata_group_id": row[4],
            }
            await cur.execute(
                """
                SELECT id::text       AS chunk_id,
                       chunk_index    AS chunk_index,
                       heading_path   AS heading_path,
                       text           AS text,
                       token_count    AS token_count
                  FROM document_chunks
                 WHERE document_id = %s::uuid
                 ORDER BY chunk_index ASC
                """,
                (doc_id,),
            )
            chunks = [
                {
                    "chunk_id": c[0],
                    "chunk_index": c[1],
                    "heading_path": c[2],
                    "text": c[3],
                    "token_count": c[4],
                }
                for c in await cur.fetchall()
            ]
        doc["chunks"] = chunks
        return doc


# Defense-in-depth on the group_id (Tranche 1 convention). We don't import
# the mcp-kg helper here because the projector connects to Neo4j directly,
# not through mcp-kg.
import re  # noqa: E402

_GROUP_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,80}$")


def _safe_group_id(group_id: str) -> str:
    if not _GROUP_ID_RE.fullmatch(group_id):
        raise ValueError(f"unsafe group_id: {group_id!r}")
    return group_id


def main() -> None:
    settings = ProjectorSettings()
    logging.basicConfig(level=settings.projector_log_level)
    proj = KgDocumentsProjector(settings)
    try:
        asyncio.run(proj.run())
    finally:
        asyncio.run(proj.close())


if __name__ == "__main__":
    main()
