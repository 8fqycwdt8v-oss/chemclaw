"""wiki_linter — periodic deterministic sweep of the knowledge wiki (ADR 012 Phase 4a).

Runs every `WIKI_LINTER_POLL_HOURS` and:
  * **missing-page** — creates a `dirty` stub `project/<internal_id>` page for any
    NCE project that has none yet (the wiki_regen daemon then fills it). Compound
    / reaction-family auto-stubbing waits for reaction-component derivation (see
    BACKLOG); for now those pages come from the agent's `request_article`.
  * **orphan** — logs any agent-authored `topic/` page with no inbound
    `[article:…]` citation (it isn't reachable from any other page). Not
    auto-fixed — orphan resolution needs human judgement.
  * **index rebuild** — regenerates the `index` page's body: a Karpathy-style
    catalog of every current page (slug · title · kind · maturity · #sources ·
    last-updated · `dirty?`), grouped by kind. Only writes when the body
    actually changed; never bumps `revision` (the index is a derived catalog,
    not a versioned document) — so it doesn't spam `knowledge_article_revised`.
  * appends a one-line summary to the `log` page.

NOT in 4a (BACKLOG / Phase 4b): the stale-citation backstop sweep (needs a
Neo4j connection to read `:Fact.invalidated_at` — the event-driven re-dirty in
the `wiki_pages` projector is the primary mechanism) and `contradiction/<slug>`
page generation (needs Neo4j + the `wiki.contradiction` LLM prompt). This phase
is pure-Postgres and LLM-free, matching the "plumbing is deterministic" rule.

Connects as `chemclaw_service` (BYPASSRLS) — it's a system worker.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("wiki-linter")

_SYSTEM = "__system__"
_INDEX_KIND_ORDER = [
    "nce_project", "synthesis_campaign", "compound", "reaction_family",
    "document_digest", "researcher", "topic", "glossary", "contradiction",
]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Postgres — chemclaw_service (BYPASSRLS) so the linter sees every project.
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    # How often the sweep runs (hours). It's a backstop, not real-time.
    wiki_linter_poll_hours: float = 6.0
    # Cap on stubs created per missing-page sweep (so a fresh DB with thousands
    # of projects doesn't flood the regen queue in one pass).
    wiki_linter_max_stubs_per_run: int = 100

    log_level: str = "INFO"

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


# ---------------------------------------------------------------------------
# Sweeps
# ---------------------------------------------------------------------------


async def _sweep_missing_project_pages(conn: psycopg.AsyncConnection[dict[str, Any]], limit: int) -> int:
    """Create a dirty stub `project/<internal_id>` page for any project lacking one."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT np.id::text AS project_id, np.internal_id, np.name
              FROM nce_projects np
             WHERE NOT EXISTS (
               SELECT 1 FROM knowledge_articles ka WHERE ka.slug = 'project/' || np.internal_id
             )
             ORDER BY np.created_at DESC
             LIMIT %s
            """,
            (limit,),
        )
        rows = await cur.fetchall()
    created = 0
    for r in rows:
        entity_ref = {"label": "NCEProject", "id_property": "internal_id", "id_value": r["internal_id"]}
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO knowledge_articles
                  (slug, kind, title, body_md, entity_ref, nce_project_id,
                   group_id, maturity, dirty, dirty_reason, created_by)
                VALUES ('project/' || %s, 'nce_project', %s, '', %s::jsonb, %s::uuid,
                        %s, 'EXPLORATORY', true, 'lint:missing_page', %s)
                ON CONFLICT (slug) DO NOTHING
                """,
                (r["internal_id"], (r["name"] or f"NCE project {r['internal_id']}")[:400],
                 json.dumps(entity_ref), r["project_id"], _SYSTEM, _SYSTEM),
            )
            created += cur.rowcount
    if created:
        await conn.commit()
        log.info("wiki-linter: created %d missing project page stub(s)", created)
    return created


async def _sweep_orphans(conn: psycopg.AsyncConnection[dict[str, Any]]) -> list[str]:
    """Log agent-authored topic pages with no inbound [article:…] citation."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT ka.slug
              FROM knowledge_articles ka
             WHERE ka.status = 'current'
               AND ka.kind = 'topic'
               AND ka.entity_ref IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM knowledge_article_citations c
                  WHERE c.cite_kind = 'article' AND c.cite_ref = ka.slug
               )
             ORDER BY ka.slug
            """,
        )
        orphans = [r["slug"] for r in await cur.fetchall()]
    if orphans:
        log.warning("wiki-linter: %d orphan topic page(s) (no inbound [article:…] link): %s",
                    len(orphans), ", ".join(orphans[:25]))
    return orphans


def _render_index(rows: list[dict[str, Any]]) -> str:
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_kind.setdefault(r["kind"], []).append(r)
    parts: list[str] = [
        "# Knowledge-wiki index",
        "",
        f"_Auto-generated by the wiki_linter — {len(rows)} current page(s)._",
        "",
    ]
    seen_kinds: set[str] = set()
    for kind in _INDEX_KIND_ORDER + sorted(set(by_kind) - set(_INDEX_KIND_ORDER)):
        if kind in seen_kinds or kind not in by_kind:
            continue
        seen_kinds.add(kind)
        parts.append(f"## {kind}")
        parts.append("")
        for r in sorted(by_kind[kind], key=lambda x: str(x["slug"])):
            flags = []
            if r.get("dirty"):
                flags.append("dirty")
            if r.get("has_human_edits"):
                flags.append("human-edited")
            mat = str(r.get("maturity") or "EXPLORATORY")
            n = int(r.get("source_count") or 0)
            summ = (r.get("summary") or "").strip().replace("\n", " ")
            if len(summ) > 160:
                summ = summ[:157] + "…"
            flagstr = f" _({', '.join(flags)})_" if flags else ""
            parts.append(f"- [`{r['slug']}`](article:{r['slug']}) — {r.get('title') or r['slug']}"
                         f" · {mat} · {n} src · upd {r.get('updated_at')}{flagstr}"
                         + (f"\n  {summ}" if summ else ""))
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


async def _rebuild_index(conn: psycopg.AsyncConnection[dict[str, Any]]) -> bool:
    """Regenerate the `index` page body; write only if it changed. No revision bump."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT slug, kind, title, summary, maturity, source_count, dirty, has_human_edits,
                   to_char(updated_at, 'YYYY-MM-DD') AS updated_at
              FROM knowledge_articles
             WHERE status = 'current' AND slug NOT IN ('index', 'log')
             ORDER BY kind, slug
            """,
        )
        rows = list(await cur.fetchall())
    body = _render_index(rows)
    async with conn.cursor() as cur:
        await cur.execute("SELECT body_md FROM knowledge_articles WHERE slug = 'index'")
        cur_row = await cur.fetchone()
    if cur_row is not None and cur_row["body_md"] == body:
        return False  # unchanged
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO knowledge_articles
              (slug, kind, title, body_md, summary, created_by, dirty)
            VALUES ('index', 'index', 'Knowledge-wiki index', %s,
                    'Auto-generated catalog of all current wiki pages.', %s, false)
            ON CONFLICT (slug) DO UPDATE SET
              body_md    = EXCLUDED.body_md,
              etag       = knowledge_articles.etag + 1,
              updated_at = NOW()
            """,
            (body, _SYSTEM),
        )
    await conn.commit()
    log.info("wiki-linter: rebuilt index page (%d entries)", len(rows))
    return True


async def _append_log(conn: psycopg.AsyncConnection[dict[str, Any]], line: str) -> None:
    """Prepend a one-line entry to the `log` page (creating it if absent), capped ~200 KB.
    No revision bump (append-only log) — `etag` bumps for any UI watching it."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO knowledge_articles
              (slug, kind, title, body_md, summary, created_by, dirty)
            VALUES ('log', 'log', 'Knowledge-wiki activity log', %s,
                    'Append-only record of wiki regen / lint / human-edit activity.',
                    %s, false)
            ON CONFLICT (slug) DO UPDATE SET
              body_md    = left(EXCLUDED.body_md || E'\n' || knowledge_articles.body_md, 200000),
              etag       = knowledge_articles.etag + 1,
              updated_at = NOW()
            """,
            (line, _SYSTEM),
        )
    await conn.commit()


# ---------------------------------------------------------------------------
# Daemon loop
# ---------------------------------------------------------------------------


async def run_once(settings: Settings) -> dict[str, Any]:
    stats: dict[str, Any] = {"stubs_created": 0, "orphans": 0, "index_rebuilt": False, "errors": 0}
    async with await psycopg.AsyncConnection.connect(settings.postgres_dsn, row_factory=dict_row) as conn:

        async def _safe(name: str, coro: Any) -> Any:
            try:
                return await coro
            except Exception as exc:  # noqa: BLE001 — keep the sweep alive
                stats["errors"] += 1
                log.exception("wiki-linter: sweep %s failed: %s", name, exc)
                try:
                    await conn.rollback()
                except Exception:  # noqa: BLE001
                    pass
                return None

        stats["stubs_created"] = await _safe(
            "missing_project_pages", _sweep_missing_project_pages(conn, settings.wiki_linter_max_stubs_per_run)
        ) or 0
        orphans = await _safe("orphans", _sweep_orphans(conn)) or []
        stats["orphans"] = len(orphans)
        stats["index_rebuilt"] = bool(await _safe("index_rebuild", _rebuild_index(conn)))

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        try:
            await _append_log(
                conn,
                f"## [{today}] lint | {stats['stubs_created']} stub(s) created · "
                f"{stats['orphans']} orphan(s) · index {'rebuilt' if stats['index_rebuilt'] else 'unchanged'}"
                + (f" · {stats['errors']} error(s)" if stats["errors"] else ""),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("wiki-linter: could not append to log page: %s", exc)
    return stats


async def amain() -> None:  # pragma: no cover — process entrypoint
    settings = Settings()
    from services.mcp_tools.common.logging import configure_logging

    configure_logging(settings.log_level, service="wiki_linter")
    log.info("wiki-linter starting; poll=%.1fh max_stubs=%d", settings.wiki_linter_poll_hours, settings.wiki_linter_max_stubs_per_run)
    while True:
        started = time.monotonic()
        try:
            stats = await run_once(settings)
            log.info("wiki-linter tick complete", extra={"event": "wiki_linter_tick", **stats,
                                                         "tick_duration_ms": int((time.monotonic() - started) * 1000)})
        except Exception as exc:  # noqa: BLE001 — keep the loop alive
            log.exception("wiki-linter tick failed: %s", exc)
        await asyncio.sleep(max(60.0, settings.wiki_linter_poll_hours * 3600.0))


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        log.info("wiki-linter stopped via KeyboardInterrupt")


if __name__ == "__main__":
    main()
