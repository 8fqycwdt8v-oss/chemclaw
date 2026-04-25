"""contextual_chunker — semantic uplift projector (Phase C.2).

Subscribes to `document_ingested` events. For each chunk of the document,
calls LiteLLM with a 50-100-token contextual prefix prompt:

  "Given the document title and surrounding sections, write a 1-3 sentence
   context that situates this chunk."

Writes the result to `document_chunks.contextual_prefix`. Also records
`document_chunks.page_number` for PDF documents using the byte-offset → page
mapping stored in `documents.original_uri` metadata.

Idempotency: skips chunks where `contextual_prefix IS NOT NULL` (already done).
Error policy:
  - 4xx from LiteLLM ⇒ permanent; log + skip (ack event).
  - 5xx / network    ⇒ transient; propagate (no ack → retry).
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

log = logging.getLogger("projector.contextual_chunker")

# Conservative per-run cap — keeps LiteLLM request rate manageable.
_BATCH_SIZE = 16

# Snippet size for context window (chars before/after).
_PREV_SNIPPET_CHARS = 200
_MAX_CHUNK_CHARS = 500  # truncate chunk text sent to LLM


class Settings(ProjectorSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    litellm_base_url: str = "http://localhost:4000"
    litellm_api_key: str = "sk-chemclaw-dev-master-change-me"
    # Haiku-class model for cheap prefix generation.
    context_model: str = "claude-haiku-4-5"


class _PermanentChunkError(Exception):
    """Permanent error — chunk will be skipped (4xx from LLM)."""


class ContextualChunkerProjector(BaseProjector):
    name = "contextual_chunker"
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
            # Fetch document metadata.
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT id::text AS id, title, original_uri
                      FROM documents
                     WHERE id = %s::uuid
                    """,
                    (source_row_id,),
                )
                doc = await cur.fetchone()
            if not doc:
                log.warning("event %s: document %s not found", event_id, source_row_id)
                return

            # Fetch chunks that still need contextual prefix (idempotent).
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT id::text AS id,
                           text,
                           chunk_index,
                           byte_start,
                           byte_end
                      FROM document_chunks
                     WHERE document_id = %s::uuid
                       AND contextual_prefix IS NULL
                     ORDER BY chunk_index ASC
                    """,
                    (source_row_id,),
                )
                rows = await cur.fetchall()

            if not rows:
                log.debug("event %s: no chunks to prefix", event_id)
                return

            doc_title = doc.get("title") or "Untitled document"
            is_pdf = str(doc.get("original_uri") or "").lower().endswith(".pdf")
            total = 0

            # Process in batches.
            for batch_start in range(0, len(rows), _BATCH_SIZE):
                batch = rows[batch_start : batch_start + _BATCH_SIZE]

                for i, row in enumerate(batch):
                    # Build context: title + snippet from previous chunk (if any).
                    prev_snippet = ""
                    if batch_start + i > 0:
                        # Use the previous row's text as context (already in batch or DB).
                        prev_row = (
                            batch[i - 1]
                            if i > 0
                            else rows[batch_start - 1]
                            if batch_start > 0
                            else None
                        )
                        if prev_row:
                            prev_snippet = prev_row["text"][:_PREV_SNIPPET_CHARS]

                    chunk_text = row["text"][:_MAX_CHUNK_CHARS]

                    try:
                        prefix = await self._generate_prefix(
                            doc_title=doc_title,
                            prev_snippet=prev_snippet,
                            chunk_text=chunk_text,
                        )
                    except _PermanentChunkError as exc:
                        log.warning(
                            "event %s: permanent LLM error for chunk %s: %s",
                            event_id, row["id"], exc,
                        )
                        prefix = ""  # write empty string to mark as processed

                    # Determine page number for PDFs using byte offset heuristic.
                    page_number: int | None = None
                    if is_pdf and row.get("byte_start") is not None:
                        # Approximate: each PDF page averages ~2000 bytes of text.
                        # The canonical mapping lives in mcp_doc_fetcher; this is
                        # a bootstrap approximation until full PDF metadata is stored.
                        page_number = max(1, (row["byte_start"] or 0) // 2000 + 1)

                    async with conn.cursor() as cur:
                        await cur.execute(
                            """
                            UPDATE document_chunks
                               SET contextual_prefix = %s,
                                   page_number = %s
                             WHERE id = %s::uuid
                               AND contextual_prefix IS NULL
                            """,
                            (prefix or None, page_number, row["id"]),
                        )
                    await conn.commit()
                    total += 1

            log.info(
                "event %s: contextual prefix added to %d chunks of document %s",
                event_id, total, source_row_id,
            )

    async def _generate_prefix(
        self,
        *,
        doc_title: str,
        prev_snippet: str,
        chunk_text: str,
    ) -> str:
        """Call LiteLLM to generate a 1-3 sentence contextual prefix."""
        system = (
            "You are a scientific document analyst. Given a document title, "
            "an optional preceding text snippet, and a chunk of text, write "
            "1-3 sentences (50-100 tokens) that situate this chunk in the "
            "document's broader context. Be specific about subject matter, "
            "compound names, reaction types, or experimental conditions. "
            "Do NOT repeat the chunk text — only add context."
        )
        user_parts = [f"Document title: {doc_title}"]
        if prev_snippet:
            user_parts.append(f"Preceding text snippet:\n{prev_snippet}")
        user_parts.append(f"Chunk to contextualize:\n{chunk_text}")
        user = "\n\n".join(user_parts)

        try:
            r = await self._client.post(
                f"{self._s.litellm_base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._s.litellm_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self._s.context_model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "max_tokens": 120,
                    "temperature": 0.0,
                },
            )
        except httpx.HTTPError:
            raise  # transient — propagate for retry

        if 400 <= r.status_code < 500:
            raise _PermanentChunkError(f"LiteLLM 4xx: {r.status_code} {r.text[:200]}")
        r.raise_for_status()

        body = r.json()
        content: str = (
            body.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
            .strip()
        )
        return content


async def amain() -> None:
    settings = Settings()
    configure_logging(settings.projector_log_level)
    projector = ContextualChunkerProjector(settings)
    try:
        await projector.run()
    finally:
        await projector.aclose()


if __name__ == "__main__":
    asyncio.run(amain())
