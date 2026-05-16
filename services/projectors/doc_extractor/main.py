"""doc_extractor — document chunk LLM fact extraction projector (Phase 2).

Subscribes to `document_ingested` events. For each event:

  1. Gate on feature flag `kg.auto_extraction.documents` (default OFF via env).
  2. Fetch document metadata + all chunks from `document_chunks`.
  3. Batch chunks (~10 per LLM call) and call LiteLLM with a structured
     extraction prompt from `prompt_registry` (`doc_extraction.extract_facts`).
  4. Parse the JSON response: list of
       {subject_label, subject_id_value, predicate, object_value?,
        unit?, derivation_class, confidence, confidence_tier, extractor_name}
  5. INSERT each fact into `facts` (ON CONFLICT DO NOTHING for idempotence).
  6. Emit one `extracted_fact` ingestion event per new fact.

Gated by `DOC_EXTRACTOR_ENABLED` env var (mirrors the `kg.auto_extraction.documents`
feature flag; default False). The projector registers on the event spine
regardless — the gate keeps it silent until the flag is enabled.

Connects as `chemclaw_service` (BYPASSRLS) so it processes all projects.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings

log = logging.getLogger("projector.doc_extractor")

_CHUNK_BATCH_SIZE = 10
_MAX_CHUNKS = 100  # cap to avoid runaway LLM cost on huge docs
_FACT_CONFIDENCE_CAP = 0.85  # LLM-extracted COMPUTED facts max at foundational
_FALLBACK_PROMPT = """\
You are a pharmaceutical chemistry knowledge extractor. Given metadata about a
document and a batch of its text chunks, extract structured facts expressed in
the document.

Return a JSON array — and ONLY that array, no preamble. Each element:
{
  "subject_label": "Compound" | "NCEProject" | "Reaction" | "OptimizationCampaign",
  "subject_id_value": "<identifier — SMILES, internal_id, or name>",
  "predicate": "<snake_case fact type, e.g. has_yield_pct>",
  "object_value": {"value": <number or string>},   // required
  "unit": "<SI unit or null>",
  "derivation_class": "COMPUTED",
  "confidence": <0.0–0.85>,
  "confidence_tier": "foundational" | "high" | "medium" | "low" | "exploratory",
  "extractor_name": "doc_extractor"
}

Rules:
- Only extract facts explicitly stated in the chunks. Never invent values.
- Prefer numeric values for measurements (yield, temperature, purity, MW, etc.).
- subject_id_value must be an identifier present in the text (SMILES string,
  compound code, project code, campaign id). Skip facts with no clear identifier.
- Confidence: 0.85 for direct numeric measurement; 0.65 for clearly stated
  categorical fact; 0.40 for summarised or paraphrased value.
- If no facts are present, return [].
"""


class DocExtractorSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    litellm_base_url: str = "http://litellm:4000"
    litellm_api_key: str = "sk-chemclaw-dev-master-change-me"
    doc_extractor_model: str = "claude-haiku-4-5"
    doc_extractor_max_tokens: int = 4096
    # Mirror of the `kg.auto_extraction.documents` feature flag.
    doc_extractor_enabled: bool = False

    projector_log_level: str = "INFO"

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------


async def _load_prompt(conn: psycopg.AsyncConnection[dict[str, Any]]) -> str:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT template FROM prompt_registry "
            "WHERE prompt_name = %s AND active "
            "ORDER BY version DESC LIMIT 1",
            ("doc_extraction.extract_facts",),
        )
        row = await cur.fetchone()
    if row is not None:
        tmpl = (row.get("template") if isinstance(row, dict) else row[0]) or ""
        if isinstance(tmpl, str) and tmpl.strip():
            return tmpl
    return _FALLBACK_PROMPT


async def _call_llm(
    client: httpx.AsyncClient,
    settings: DocExtractorSettings,
    system_prompt: str,
    user_content: str,
) -> list[dict[str, Any]]:
    try:
        r = await client.post(
            f"{settings.litellm_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.litellm_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": settings.doc_extractor_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                "max_tokens": settings.doc_extractor_max_tokens,
                "temperature": 0.0,
            },
        )
    except httpx.HTTPError as exc:
        log.warning("doc_extractor LiteLLM network error: %s", exc)
        return []

    if r.status_code >= 400:
        log.warning("doc_extractor LiteLLM %s: %.200s", r.status_code, r.text)
        return []

    try:
        choices = r.json().get("choices") or [{}]
        content = ((choices[0] or {}).get("message", {}).get("content", "") or "").strip()
    except Exception as exc:  # noqa: BLE001
        log.warning("doc_extractor failed to parse LiteLLM response: %s", exc)
        return []

    # Strip markdown code fence if model added one
    if content.startswith("```"):
        content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        log.warning("doc_extractor LLM returned non-JSON: %s — %.100s", exc, content)
        return []

    if not isinstance(parsed, list):
        log.warning("doc_extractor LLM returned non-list JSON")
        return []

    return parsed


# ---------------------------------------------------------------------------
# Fact validation + clamping
# ---------------------------------------------------------------------------


def _valid_fact(raw: Any) -> bool:
    if not isinstance(raw, dict):
        return False
    required = ("subject_label", "subject_id_value", "predicate", "object_value", "derivation_class", "confidence")
    return all(raw.get(k) for k in required)


def _clamp_confidence(conf: Any) -> float:
    try:
        v = float(conf)
    except (TypeError, ValueError):
        return 0.40
    return max(0.0, min(v, _FACT_CONFIDENCE_CAP))


def _confidence_tier(conf: float) -> str:
    if conf >= 0.85:
        return "foundational"
    if conf >= 0.65:
        return "high"
    if conf >= 0.40:
        return "medium"
    if conf >= 0.20:
        return "low"
    return "exploratory"


# ---------------------------------------------------------------------------
# Projector
# ---------------------------------------------------------------------------


class DocExtractorProjector(BaseProjector):
    """Projector: document_ingested → LLM extraction → facts."""

    name = "doc_extractor"
    interested_event_types = ("document_ingested",)

    def __init__(self, settings: ProjectorSettings, ext_settings: DocExtractorSettings) -> None:
        super().__init__(settings)
        self._ext = ext_settings

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,  # noqa: ARG002
        source_table: str | None,  # noqa: ARG002
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        if not self._ext.doc_extractor_enabled:
            log.debug("doc_extractor disabled (DOC_EXTRACTOR_ENABLED=false); skipping %s", event_id)
            return

        document_id = (
            payload.get("document_id")
            or (source_row_id if source_table == "documents" else None)
        )
        if not document_id:
            log.warning("doc_extractor: event %s has no document_id; skipping", event_id)
            return

        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn, row_factory=dict_row
        ) as conn:
            await self._process_document(conn, event_id, str(document_id))
            await conn.commit()

    async def _process_document(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        event_id: str,
        document_id: str,
    ) -> None:
        # Fetch document metadata
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT id::text AS id, sha256, title, source_type, "
                "       metadata, ingested_at::text AS ingested_at "
                "FROM documents WHERE id = %s::uuid",
                (document_id,),
            )
            doc = await cur.fetchone()

        if not doc:
            log.warning("doc_extractor: document %s not found; skipping event %s", document_id, event_id)
            return

        # Fetch chunks (bounded)
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT chunk_index, heading_path, text, token_count "
                "FROM document_chunks WHERE document_id = %s::uuid "
                "ORDER BY chunk_index LIMIT %s",
                (document_id, _MAX_CHUNKS),
            )
            chunks = list(await cur.fetchall())

        if not chunks:
            log.debug("doc_extractor: document %s has no chunks; skipping", document_id)
            return

        prompt = await _load_prompt(conn)
        total_facts = 0

        doc_meta = {
            "document_id": doc.get("id") or document_id,
            "sha256": doc.get("sha256", ""),
            "title": doc.get("title", ""),
            "source_type": doc.get("source_type", ""),
        }

        n_batches = math.ceil(len(chunks) / _CHUNK_BATCH_SIZE)
        async with httpx.AsyncClient(timeout=90.0) as client:
            for batch_idx in range(n_batches):
                batch = chunks[batch_idx * _CHUNK_BATCH_SIZE : (batch_idx + 1) * _CHUNK_BATCH_SIZE]
                user_content = json.dumps(
                    {
                        "document": doc_meta,
                        "chunks": [
                            {
                                "chunk_index": c.get("chunk_index") if isinstance(c, dict) else c[0],
                                "heading_path": c.get("heading_path") if isinstance(c, dict) else c[1],
                                "text": (c.get("text") if isinstance(c, dict) else c[2] or "")[:3000],
                            }
                            for c in batch
                        ],
                    },
                    default=str,
                )[:60000]

                raw_facts = await _call_llm(client, self._ext, prompt, user_content)

                for raw in raw_facts:
                    if not _valid_fact(raw):
                        continue
                    conf = _clamp_confidence(raw.get("confidence"))
                    tier = _confidence_tier(conf)

                    inserted_id = await _insert_fact(conn, raw, conf, tier, document_id)
                    if inserted_id:
                        await _emit_extracted_fact_event(conn, inserted_id, raw, doc_meta["sha256"])
                        total_facts += 1

        log.info(
            "doc_extractor: document %s extracted %d facts (%d batches)",
            document_id, total_facts, n_batches,
        )


# ---------------------------------------------------------------------------
# DB write helpers
# ---------------------------------------------------------------------------


async def _insert_fact(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    raw: dict[str, Any],
    conf: float,
    tier: str,
    document_id: str,
) -> str | None:
    """INSERT a fact row; return its id, or None if ON CONFLICT DO NOTHING fired."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO facts (
              subject_label, subject_id_value, predicate,
              object_value, unit, polarity,
              derivation_class, confidence, confidence_tier,
              source_table, source_row_id, extractor_name, derivation_depth
            ) VALUES (
              %s, %s, %s, %s::jsonb, %s, 'positive',
              %s, %s, %s,
              'documents', %s, 'doc_extractor', 1
            )
            ON CONFLICT DO NOTHING
            RETURNING id::text
            """,
            (
                str(raw.get("subject_label", "")),
                str(raw.get("subject_id_value", "")),
                str(raw.get("predicate", "")),
                json.dumps(raw.get("object_value")) if raw.get("object_value") is not None else "{}",
                raw.get("unit"),
                str(raw.get("derivation_class", "COMPUTED")),
                conf,
                tier,
                document_id,
            ),
        )
        row = await cur.fetchone()

    if row is None:
        return None
    return str(row.get("id") if isinstance(row, dict) else row[0])


async def _emit_extracted_fact_event(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    fact_id: str,
    raw: dict[str, Any],
    sha256: str,
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO ingestion_events
              (event_type, source_table, source_row_id, payload)
            VALUES ('extracted_fact', 'facts', %s,
                    jsonb_build_object(
                      'fact_id', %s::text,
                      'extractor', 'doc_extractor',
                      'derivation_class', %s::text,
                      'predicate', %s::text,
                      'document_sha256', %s::text
                    ))
            """,
            (
                fact_id,
                fact_id,
                str(raw.get("derivation_class", "COMPUTED")),
                str(raw.get("predicate", "")),
                sha256,
            ),
        )


def main() -> None:  # pragma: no cover
    base_settings = ProjectorSettings()
    ext_settings = DocExtractorSettings()
    configure_logging(base_settings.projector_log_level)
    asyncio.run(DocExtractorProjector(base_settings, ext_settings).run())


if __name__ == "__main__":  # pragma: no cover
    main()
