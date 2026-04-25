"""chunk_embedder — BGE-M3 embeddings projector.

Subscribes to `document_ingested` events. For each chunk of the document
whose `embedding` column is NULL, calls mcp-embedder and writes the vector
back. Batches per-document for throughput.

Error policy (mirrors reaction_vectorizer):
- 4xx from mcp-embedder ⇒ permanent; log + skip (ack event)
- 5xx / network         ⇒ transient; propagate (no ack → retry)
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings

log = logging.getLogger("projector.chunk_embedder")

# Conservative per-batch cap — stays well under mcp-embedder's 128 input cap.
_BATCH_SIZE = 32


class Settings(ProjectorSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    mcp_embedder_url: str = "http://localhost:8004"


class _BadChunkError(Exception):
    """Permanent error — chunk will be acked without writing an embedding."""


class ChunkEmbedderProjector(BaseProjector):
    name = "chunk_embedder"
    interested_event_types = ("document_ingested",)

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self._s: Settings = settings
        self._client = httpx.AsyncClient(timeout=60.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,  # noqa: ARG002
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],  # noqa: ARG002
    ) -> None:
        if source_table != "documents" or not source_row_id:
            return

        async with await psycopg.AsyncConnection.connect(
            self._s.postgres_dsn, row_factory=dict_row
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT id::text AS id, text, contextual_prefix
                      FROM document_chunks
                     WHERE document_id = %s::uuid
                       AND embedding IS NULL
                     ORDER BY chunk_index ASC
                    """,
                    (source_row_id,),
                )
                rows = await cur.fetchall()

            if not rows:
                log.debug("event %s: no chunks to embed", event_id)
                return

            total = 0
            for batch_start in range(0, len(rows), _BATCH_SIZE):
                batch = rows[batch_start : batch_start + _BATCH_SIZE]
                # Phase C.2: if contextual_prefix is set, prepend it to the chunk text
                # before embedding. Backward compat: chunks without prefix embed as before.
                inputs = [
                    (r["contextual_prefix"] + "\n\n" + r["text"])
                    if r.get("contextual_prefix")
                    else r["text"]
                    for r in batch
                ]
                try:
                    vectors = await self._embed(inputs)
                except _BadChunkError as exc:
                    log.warning(
                        "embed batch starting at %d failed permanently: %s",
                        batch_start, exc,
                    )
                    continue

                # Upserts per row. A single multi-row UPDATE with VALUES
                # would be faster; this is clearer and batches are bounded
                # so latency is fine for department-scale ingest.
                async with conn.cursor() as cur:
                    for row, vec in zip(batch, vectors, strict=True):
                        literal = "[" + ",".join(f"{v:.8f}" for v in vec) + "]"
                        await cur.execute(
                            "UPDATE document_chunks SET embedding = %s::vector WHERE id = %s::uuid",
                            (literal, row["id"]),
                        )
                await conn.commit()
                total += len(batch)

            log.info("event %s: embedded %d chunks", event_id, total)

    async def _embed(self, inputs: list[str]) -> list[list[float]]:
        try:
            r = await self._client.post(
                f"{self._s.mcp_embedder_url}/tools/embed_text",
                json={"inputs": inputs, "normalize": True},
            )
        except httpx.HTTPError:
            raise  # transient

        if 400 <= r.status_code < 500:
            raise _BadChunkError(f"embedder 4xx: {r.status_code}")
        r.raise_for_status()

        body = r.json()
        vectors: list[list[float]] = body["vectors"]
        dim = body.get("dim")
        if not isinstance(vectors, list) or not vectors:
            raise _BadChunkError("embedder returned no vectors")
        if dim is not None and any(len(v) != dim for v in vectors):
            raise _BadChunkError("embedder returned inconsistent dims")
        return vectors


async def amain() -> None:
    settings = Settings()
    configure_logging(settings.projector_log_level)
    projector = ChunkEmbedderProjector(settings)
    try:
        await projector.run()
    finally:
        await projector.aclose()


if __name__ == "__main__":
    asyncio.run(amain())
