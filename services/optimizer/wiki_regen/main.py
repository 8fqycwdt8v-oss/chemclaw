"""wiki_regen — knowledge-wiki body-synthesis daemon (ADR 012 Phase 2b).

Phase 2a's `wiki_pages` projector marks `knowledge_articles` rows `dirty` and
creates stubs (`body_md = ''`). This daemon fills them: every poll it picks
the oldest `dirty` entity-backed page that's been dirty for at least
`debounce_seconds` (so a burst of events collapses into one regen), gathers a
compact context of what's known about the entity from Postgres, asks the
`wiki.synthesis` prompt (read from `prompt_registry`, with a built-in fallback)
to write a cited markdown page, records the inline `[fact:…]` / `[experiment:…]`
/ `[document:…]` citations into `knowledge_article_citations`, writes a
`knowledge_article_revisions` row (`author_kind = 'projector'`), preserves any
`<!-- human:begin … -->…<!-- human:end -->` blocks verbatim, clears `dirty`,
and prepends a line to the `log` page.

Scope: regenerates entity-backed kinds (`document_digest`, `nce_project`,
`synthesis_campaign`, `compound`, `reaction_family`). `topic` / `glossary` /
`index` / `log` / `contradiction` pages have `entity_ref IS NULL` and are NOT
auto-regenerated (agent-/human-authored, or owned by the Phase-4 linter).
`compound` / `reaction_family` pages today only exist via the agent's
`request_article` (their auto-stubbing waits for reaction-component derivation —
see BACKLOG); when they do exist this daemon regenerates them best-effort.

Rate-limited to `max_per_hour` regens (a sliding window) and `batch_size` per
tick. All LLM traffic goes through the central LiteLLM endpoint.

Connects as `chemclaw_service` (BYPASSRLS) so it sees every project's pages —
filtering is by the entity_ref the projector stamped, not RLS.
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("wiki-regen")

# Inline-citation grammar — must stay in sync with
# services/agent-claw/src/tools/builtins/_wiki_shared.ts:parseInlineCitations.
_CITE_RE = re.compile(
    r"\[(fact|chunk|experiment|reaction|hypothesis|artifact|document|article):([^\]\s]+)\]"
)
_HUMAN_BLOCK_RE = re.compile(
    r"<!--\s*human:begin\b[^>]*-->.*?<!--\s*human:end\s*-->", re.IGNORECASE | re.DOTALL
)

# Built-in fallback used when prompt_registry has no active `wiki.synthesis`
# row (e.g. `make db.seed` not run). The seeded version (db/seed/) is the
# source of truth; this keeps the daemon functional without it.
_FALLBACK_PROMPT = """\
You are the editor of a pharmaceutical chemical & analytical-development
knowledge wiki. Given a page descriptor and a JSON context of everything the
system currently knows about the entity, write a concise, well-structured
Markdown page (≤ ~1500 words).

Rules:
- Use ONLY facts present in the supplied context. Do not invent compound
  names, yields, conditions, identifiers, or relationships. If the context is
  thin, write a short page and say what is not yet known.
- Cite inline using these exact forms (the IDs come from the context):
  [fact:<uuid>] [experiment:<id>] [reaction:<id>] [chunk:<id>]
  [hypothesis:<id>] [artifact:<id>] [document:<sha>] [article:<slug>].
- Open with a one-line summary, then sections appropriate to the page kind
  (identity / structure / where it appears / open questions for a compound;
  goal / route / steps / outcomes for a project or campaign; summary / key
  extractions / cited-by for a document digest).
- If the context includes `human_blocks`, reproduce each verbatim, unchanged,
  somewhere in the page (e.g. under a "Curator notes" heading).
- Output ONLY the Markdown body — no preamble, no code fences around the
  whole thing.
"""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Postgres — chemclaw_service (BYPASSRLS) so the daemon sees all projects.
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    # Central LiteLLM endpoint (single egress chokepoint + redaction).
    litellm_base_url: str = "http://litellm:4000"
    litellm_api_key: str = "sk-chemclaw-dev-master-change-me"
    # Mirrors config_settings `wiki.regen.model`.
    wiki_regen_model: str = "claude-haiku-4-5"

    # Mirrors config_settings `wiki.regen.*`. The catalog rows live in
    # db/init/60_wiki_regen_config.sql; this daemon reads the env vars.
    wiki_regen_poll_seconds: int = 120
    wiki_regen_debounce_seconds: int = 300
    wiki_regen_max_per_hour: int = 200
    wiki_regen_batch_size: int = 8
    wiki_regen_max_tokens: int = 2200

    log_level: str = "INFO"

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class _SkipPage(Exception):
    """Skip this page this tick (transient: LLM 5xx/network, or thin context).
    The page stays dirty and is retried next tick."""


class _PermanentSkip(Exception):
    """Skip this page permanently this tick AND clear dirty would be wrong, so
    we just log + leave it dirty; the linter (Phase 4) flags persistently-bad
    pages. Used for malformed entity_ref / missing canonical row."""


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

_FIND_DIRTY_SQL = """
SELECT id::text AS id, slug, kind, title, entity_ref, nce_project_id::text AS nce_project_id,
       body_md, has_human_edits, revision, dirty_reason
  FROM knowledge_articles
 WHERE dirty
   AND status = 'current'
   AND entity_ref IS NOT NULL
   AND updated_at < NOW() - make_interval(secs => %s)
 ORDER BY updated_at ASC
 LIMIT %s
"""


async def _fetch_one(conn: psycopg.AsyncConnection[dict[str, Any]], sql: str, params: tuple[Any, ...]) -> dict[str, Any] | None:
    async with conn.cursor() as cur:
        await cur.execute(sql, params)
        return await cur.fetchone()


async def _fetch_all(conn: psycopg.AsyncConnection[dict[str, Any]], sql: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    async with conn.cursor() as cur:
        await cur.execute(sql, params)
        return list(await cur.fetchall())


async def _load_prompt(conn: psycopg.AsyncConnection[dict[str, Any]]) -> str:
    row = await _fetch_one(
        conn,
        "SELECT template FROM prompt_registry WHERE prompt_name = 'wiki.synthesis' AND active ORDER BY version DESC LIMIT 1",
        (),
    )
    if row is not None:
        template: object = row.get("template")
        if isinstance(template, str) and template.strip():
            return template
    return _FALLBACK_PROMPT


# ---------------------------------------------------------------------------
# Context gathering — one builder per entity-backed kind
# ---------------------------------------------------------------------------


def _entity_value(page: dict[str, Any]) -> str:
    er = page.get("entity_ref")
    v: object = er.get("id_value") if isinstance(er, dict) else None
    if not isinstance(v, str) or not v:
        raise _PermanentSkip(f"page {page['slug']} has no usable entity_ref.id_value")
    return v


async def _ctx_document(conn: psycopg.AsyncConnection[dict[str, Any]], page: dict[str, Any]) -> dict[str, Any]:
    sha = _entity_value(page)
    doc = await _fetch_one(
        conn,
        "SELECT id::text AS id, title, source_type, version, effective_date::text AS effective_date, "
        "left(parsed_markdown, 8000) AS excerpt FROM documents WHERE sha256 = %s",
        (sha,),
    )
    if not doc:
        raise _SkipPage(f"document {sha[:8]} not found")
    chunks = await _fetch_all(
        conn,
        "SELECT chunk_index, heading_path FROM document_chunks WHERE document_id = %s::uuid ORDER BY chunk_index LIMIT 60",
        (doc["id"],),
    )
    return {
        "page_kind": "document_digest",
        "document": {"sha256": sha, "cite": f"document:{sha[:16]}", "title": doc["title"], "source_type": doc["source_type"], "version": doc.get("version"), "effective_date": doc.get("effective_date")},
        "outline": [{"chunk_index": c["chunk_index"], "heading_path": c["heading_path"]} for c in chunks],
        "excerpt": doc["excerpt"],
    }


async def _ctx_project(conn: psycopg.AsyncConnection[dict[str, Any]], page: dict[str, Any]) -> dict[str, Any]:
    iid = _entity_value(page)
    proj = await _fetch_one(
        conn,
        "SELECT id::text AS id, name, therapeutic_area, phase, status FROM nce_projects WHERE internal_id = %s",
        (iid,),
    )
    if not proj:
        raise _SkipPage(f"nce_project {iid} not found")
    steps = await _fetch_all(
        conn,
        "SELECT step_index, step_name, target_compound_inchikey FROM synthetic_steps WHERE nce_project_id = %s::uuid ORDER BY step_index",
        (proj["id"],),
    )
    exp_count = await _fetch_one(
        conn,
        "SELECT count(*) AS n FROM experiments e JOIN synthetic_steps ss ON ss.id = e.synthetic_step_id WHERE ss.nce_project_id = %s::uuid",
        (proj["id"],),
    )
    hyps = await _fetch_all(
        conn,
        "SELECT id::text AS id, hypothesis_text, confidence, confidence_tier FROM hypotheses "
        "WHERE scope_nce_project_id = %s::uuid AND status = 'proposed' ORDER BY confidence DESC NULLS LAST LIMIT 20",
        (proj["id"],),
    )
    return {
        "page_kind": "nce_project",
        "project": {"internal_id": iid, "cite": f"project:{iid}", "name": proj["name"], "therapeutic_area": proj.get("therapeutic_area"), "phase": proj.get("phase"), "status": proj.get("status")},
        "synthetic_steps": [{"step_index": s["step_index"], "step_name": s["step_name"], "target_compound_inchikey": s["target_compound_inchikey"]} for s in steps],
        "experiment_count": (exp_count or {}).get("n", 0),
        "open_hypotheses": [{"cite": f"hypothesis:{h['id']}", "text": h["hypothesis_text"], "confidence": float(h["confidence"]) if h.get("confidence") is not None else None, "tier": h.get("confidence_tier")} for h in hyps],
    }


async def _ctx_campaign(conn: psycopg.AsyncConnection[dict[str, Any]], page: dict[str, Any]) -> dict[str, Any]:
    cid = _entity_value(page)
    camp = await _fetch_one(
        conn,
        "SELECT id::text AS id, name, kind, status, goal, policy, outcome_summary, total_steps, completed_steps FROM synthesis_campaigns WHERE id = %s::uuid",
        (cid,),
    )
    if not camp:
        raise _SkipPage(f"synthesis_campaign {cid[:8]} not found")
    steps = await _fetch_all(
        conn,
        "SELECT step_index, kind, status, notes, ref_table, ref_id FROM synthesis_campaign_steps WHERE campaign_id = %s::uuid ORDER BY step_index",
        (cid,),
    )
    events = await _fetch_all(
        conn,
        "SELECT event_type, payload, occurred_at::text AS occurred_at FROM synthesis_campaign_events WHERE campaign_id = %s::uuid ORDER BY occurred_at DESC LIMIT 25",
        (cid,),
    )
    return {
        "page_kind": "synthesis_campaign",
        "campaign": {"id": cid, "cite": f"article:campaign/{cid}", "name": camp["name"], "kind": camp["kind"], "status": camp["status"], "goal": camp["goal"], "policy": camp["policy"], "outcome_summary": camp.get("outcome_summary"), "total_steps": camp.get("total_steps"), "completed_steps": camp.get("completed_steps")},
        "steps": [{"step_index": s["step_index"], "kind": s["kind"], "status": s["status"], "notes": s.get("notes"), "ref_table": s.get("ref_table"), "ref_id": s.get("ref_id")} for s in steps],
        "recent_events": [{"event_type": e["event_type"], "payload": e["payload"], "occurred_at": e["occurred_at"]} for e in events],
    }


async def _ctx_compound(conn: psycopg.AsyncConnection[dict[str, Any]], page: dict[str, Any]) -> dict[str, Any]:
    ik = _entity_value(page)
    cmp = await _fetch_one(
        conn,
        "SELECT inchikey, smiles_canonical, molecular_formula, mw, chebi_id, pubchem_cid, internal_code_masked FROM compounds WHERE inchikey = %s",
        (ik,),
    )
    if not cmp:
        raise _SkipPage(f"compound {ik[:14]} not found")
    return {
        "page_kind": "compound",
        "compound": {"inchikey": ik, "cite": f"article:compound/{ik}", "smiles": cmp.get("smiles_canonical"), "molecular_formula": cmp.get("molecular_formula"), "mw": float(cmp["mw"]) if cmp.get("mw") is not None else None, "chebi_id": cmp.get("chebi_id"), "pubchem_cid": cmp.get("pubchem_cid"), "internal_code": cmp.get("internal_code_masked")},
        "note": "Reaction / experiment links for this compound are not yet derived (pending reaction-component projection). Cover identity + properties; defer where-it-appears to 'not yet linked'.",
    }


async def _ctx_reaction_family(conn: psycopg.AsyncConnection[dict[str, Any]], page: dict[str, Any]) -> dict[str, Any]:
    rxno = _entity_value(page)
    rxns = await _fetch_all(
        conn,
        "SELECT id::text AS id, rxn_smiles, rxno_class, confidence_tier FROM reactions WHERE rxno_class = %s ORDER BY id LIMIT 50",
        (rxno,),
    )
    if not rxns:
        raise _SkipPage(f"no reactions for rxno_class {rxno}")
    return {
        "page_kind": "reaction_family",
        "rxno_class": rxno,
        "reactions": [{"cite": f"reaction:{r['id']}", "rxn_smiles": r["rxn_smiles"], "confidence_tier": r.get("confidence_tier")} for r in rxns],
    }


_CTX_BUILDERS = {
    "document_digest": _ctx_document,
    "nce_project": _ctx_project,
    "synthesis_campaign": _ctx_campaign,
    "compound": _ctx_compound,
    "reaction_family": _ctx_reaction_family,
}


# ---------------------------------------------------------------------------
# Synthesis + apply
# ---------------------------------------------------------------------------


def _human_blocks(body: str) -> list[str]:
    return _HUMAN_BLOCK_RE.findall(body or "")


def _ensure_human_blocks(new_body: str, blocks: list[str]) -> str:
    """Append any human:* block not already present verbatim, under a heading."""
    missing = [b for b in blocks if b not in new_body]
    if not missing:
        return new_body
    return new_body.rstrip() + "\n\n## Curator notes\n\n" + "\n\n".join(missing) + "\n"


def _parse_citations(body: str) -> list[tuple[str, str]]:
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for m in _CITE_RE.finditer(body):
        kind, ref = m.group(1), m.group(2)[:512]
        key = f"{kind}::{ref}"
        if key in seen:
            continue
        seen.add(key)
        out.append((kind, ref))
    return out


async def _synthesize(
    client: httpx.AsyncClient, settings: Settings, prompt: str, page: dict[str, Any], context: dict[str, Any],
) -> str:
    blocks = _human_blocks(page.get("body_md") or "") if page.get("has_human_edits") else []
    user_obj = {
        "page": {"slug": page["slug"], "kind": page["kind"], "title": page["title"]},
        "context": context,
        "human_blocks": blocks,
    }
    user = (
        "Write the wiki page for the entity below. Output ONLY the Markdown body.\n\n"
        + json.dumps(user_obj, default=str)[:60000]
    )
    try:
        r = await client.post(
            f"{settings.litellm_base_url}/chat/completions",
            headers={"Authorization": f"Bearer {settings.litellm_api_key}", "Content-Type": "application/json"},
            json={
                "model": settings.wiki_regen_model,
                "messages": [{"role": "system", "content": prompt}, {"role": "user", "content": user}],
                "max_tokens": settings.wiki_regen_max_tokens,
                "temperature": 0.1,
            },
        )
    except httpx.HTTPError as exc:
        raise _SkipPage(f"LiteLLM network error: {exc}") from exc
    if 400 <= r.status_code < 500:
        # 4xx is usually a too-long context or a bad model name — treat as
        # transient (the linter will surface a page that never regenerates).
        raise _SkipPage(f"LiteLLM {r.status_code}: {r.text[:200]}")
    r.raise_for_status()
    choices = r.json().get("choices") or [{}]
    body = ((choices[0] or {}).get("message", {}).get("content", "") or "").strip()
    if not body:
        raise _SkipPage("LiteLLM returned an empty body")
    # Strip a single wrapping ```markdown fence if the model added one.
    body = re.sub(r"^```(?:markdown|md)?\s*\n", "", body)
    body = re.sub(r"\n```\s*$", "", body)
    return body[:200_000]


async def _append_log(conn: psycopg.AsyncConnection[dict[str, Any]], line: str) -> None:
    """Prepend a one-line entry to the `log` page (creating it if absent),
    capped at ~200 KB. Append-only — no revision-history row, and we do NOT
    bump `revision` (so the trigger doesn't emit a `knowledge_article_revised`
    event for `log` on every regen); `etag` still bumps for any UI watching it."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO knowledge_articles
              (slug, kind, title, body_md, summary, created_by, dirty)
            VALUES ('log', 'log', 'Knowledge-wiki activity log', %s,
                    'Append-only record of wiki regen / lint / human-edit activity.',
                    '__system__', false)
            ON CONFLICT (slug) DO UPDATE SET
              body_md    = left(EXCLUDED.body_md || E'\n' || knowledge_articles.body_md, 200000),
              etag       = knowledge_articles.etag + 1,
              updated_at = NOW()
            """,
            (line,),
        )


async def _apply_regen(
    conn: psycopg.AsyncConnection[dict[str, Any]], page: dict[str, Any], new_body: str,
) -> int | None:
    """Write the regenerated body + a revision row + citations; clear dirty.

    Returns the new revision, or None if the page was no longer dirty (a human
    PATCH or a concurrent regen won the race) — in which case we don't touch it.
    """
    citations = _parse_citations(new_body)
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE knowledge_articles SET
              body_md          = %s,
              source_count     = %s,
              dirty            = false,
              dirty_reason     = NULL,
              last_edited_by   = '__projector__',
              revision         = revision + 1,
              etag             = etag + 1,
              updated_at       = NOW()
            WHERE id = %s::uuid AND dirty
            RETURNING revision
            """,
            (new_body, len(citations), page["id"]),
        )
        row = await cur.fetchone()
    if not row:
        return None
    rev = int(row["revision"])
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO knowledge_article_revisions
              (article_id, revision, title, summary, body_md, author_kind, author_entra_id, change_note)
            SELECT %s::uuid, %s, title, summary, %s, 'projector', NULL, %s
              FROM knowledge_articles WHERE id = %s::uuid
            """,
            (page["id"], rev, new_body, f"regenerated (was dirty: {page.get('dirty_reason') or 'unknown'})"[:500], page["id"]),
        )
    if citations:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO knowledge_article_citations (article_id, revision, cite_kind, cite_ref)
                SELECT %s::uuid, %s, k, r FROM unnest(%s::text[], %s::text[]) AS t(k, r)
                ON CONFLICT (article_id, revision, cite_kind, cite_ref) DO NOTHING
                """,
                (page["id"], rev, [c[0] for c in citations], [c[1] for c in citations]),
            )
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    await _append_log(conn, f"## [{today}] regen | {page['slug']} | rev {rev} | {len(citations)} citation(s)")
    return rev


# ---------------------------------------------------------------------------
# Daemon loop
# ---------------------------------------------------------------------------


async def _process_page(
    conn: psycopg.AsyncConnection[dict[str, Any]], client: httpx.AsyncClient, settings: Settings, prompt: str, page: dict[str, Any],
) -> bool:
    """Returns True if a regen was applied (counts toward the rate limit)."""
    builder = _CTX_BUILDERS.get(page["kind"])
    if builder is None:
        log.warning("page %s: no context builder for kind=%s — leaving dirty", page["slug"], page["kind"])
        return False
    # Phase 1 — gather context in its own short read transaction, then commit
    # so the (slow) LiteLLM call below doesn't hold a transaction open.
    try:
        context = await builder(conn, page)
        await conn.commit()
    except _PermanentSkip as exc:
        await conn.rollback()
        log.warning("page %s: %s — leaving dirty", page["slug"], exc)
        return False
    except _SkipPage as exc:
        await conn.rollback()
        log.info("page %s: %s — retry next tick", page["slug"], exc)
        return False
    # Phase 2 — synthesise (no DB transaction held).
    try:
        body = await _synthesize(client, settings, prompt, page, context)
    except _SkipPage as exc:
        log.info("page %s: synthesis skipped (%s) — retry next tick", page["slug"], exc)
        return False
    if page.get("has_human_edits"):
        body = _ensure_human_blocks(body, _human_blocks(page.get("body_md") or ""))
    # Phase 3 — write in a fresh transaction; _apply_regen re-checks `dirty`
    # so a concurrent regen / human PATCH that won the race is a clean no-op.
    rev = await _apply_regen(conn, page, body)
    await conn.commit()
    if rev is None:
        log.info("page %s: no longer dirty (raced) — skipped", page["slug"])
        return False
    log.info("page %s: regenerated → rev %d (%d chars)", page["slug"], rev, len(body))
    return True


async def amain() -> None:  # pragma: no cover — process entrypoint
    settings = Settings()
    from services.mcp_tools.common.logging import configure_logging

    configure_logging(settings.log_level, service="wiki_regen")
    log.info(
        "wiki-regen starting; model=%s poll=%ds debounce=%ds max/h=%d batch=%d",
        settings.wiki_regen_model, settings.wiki_regen_poll_seconds,
        settings.wiki_regen_debounce_seconds, settings.wiki_regen_max_per_hour,
        settings.wiki_regen_batch_size,
    )
    window: collections.deque[float] = collections.deque()  # regen timestamps (last hour)

    async with httpx.AsyncClient(timeout=90.0) as client:
        while True:
            tick_started = time.monotonic()
            regenerated = 0
            errors = 0
            try:
                async with await psycopg.AsyncConnection.connect(settings.postgres_dsn, row_factory=dict_row) as conn:
                    prompt = await _load_prompt(conn)
                    pages = await _fetch_all(conn, _FIND_DIRTY_SQL, (settings.wiki_regen_debounce_seconds, settings.wiki_regen_batch_size))
                    for page in pages:
                        # Sliding-window rate limit.
                        now = time.time()
                        while window and now - window[0] > 3600:
                            window.popleft()
                        if len(window) >= settings.wiki_regen_max_per_hour:
                            log.info("wiki-regen rate cap reached (%d/h) — pausing until next tick", settings.wiki_regen_max_per_hour)
                            break
                        try:
                            if await _process_page(conn, client, settings, prompt, page):
                                regenerated += 1
                                window.append(time.time())
                        except Exception as exc:  # noqa: BLE001 — keep the batch alive
                            errors += 1
                            log.exception("page %s: regen raised; skipping: %s", page.get("slug"), exc)
                            try:
                                await conn.rollback()
                            except Exception:  # noqa: BLE001
                                pass
            except Exception as exc:  # noqa: BLE001 — keep the loop alive
                errors += 1
                log.exception("wiki-regen tick failed: %s", exc)
            log.info(
                "wiki-regen tick complete",
                extra={"event": "wiki_regen_tick", "regenerated": regenerated, "errors": errors,
                       "tick_duration_ms": int((time.monotonic() - tick_started) * 1000)},
            )
            await asyncio.sleep(settings.wiki_regen_poll_seconds)


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        log.info("wiki-regen stopped via KeyboardInterrupt")


if __name__ == "__main__":
    main()
