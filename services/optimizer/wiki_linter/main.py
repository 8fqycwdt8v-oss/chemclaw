"""wiki_linter — periodic deterministic sweep of the knowledge wiki (ADR 012 Phase 4a + 4b-ii).

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
  * **stale citations** (Phase 4b-ii, optional — needs Neo4j) — for every
    current page citing `fact:<uuid>` references, ask Neo4j which of those
    facts have been invalidated (`:Fact.invalidated_at IS NOT NULL` or all
    incoming `:CITES.invalidated_at IS NOT NULL`). Mark citing pages dirty
    with `dirty_reason='lint:stale_citation'` if they're not already dirty.
    Belt-and-braces backstop for the event-driven `wiki_pages` re-dirty path.
  * **contradictions** (Phase 4b-ii, optional — needs Neo4j) — for every
    `(subject_label, subject_id_value, predicate)` group in the KG with ≥2
    distinct active object values, create a `dirty` `contradiction/<slug>`
    stub if none exists. `wiki_regen` fills the body via the
    `wiki.contradiction` prompt.
  * appends a one-line summary to the `log` page.

The Neo4j-backed sweeps are skipped when `NEO4J_URI` is unset — the linter
keeps running its pure-Postgres sweeps. The "plumbing is deterministic" rule
holds: no LLM in the linter itself; LLM only fires downstream in `wiki_regen`.

Connects as `chemclaw_service` (BYPASSRLS) — it's a system worker.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
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
# Slug-safe characters for the contradiction slug derivation. Subject /
# predicate values can contain `/`, `:`, `-`, etc.; the
# `knowledge_articles.slug` column allows `[A-Za-z0-9_./-]` only.
_SLUG_SAFE_RE = re.compile(r"[^A-Za-z0-9_./-]")


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
    # Minimum distinct active object values to declare a contradiction. Below
    # this threshold the disagreement is treated as ordinary KG noise.
    wiki_linter_contradiction_min_objects: int = 2
    # Cap on the number of contradiction stubs created per sweep (the same
    # rationale as the missing-page cap above).
    wiki_linter_max_contradictions_per_run: int = 25
    # Cap on the number of pages re-dirtied per stale-citation sweep.
    wiki_linter_max_stale_per_run: int = 200

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
    # Commit unconditionally — even when every INSERT hit the conflict path
    # (created == 0) we still want the SELECT's read transaction closed before
    # the next sweep runs, matching wiki_regen's "commit after each phase".
    await conn.commit()
    if created:
        log.info("wiki-linter: created %d missing project page stub(s)", created)
    return created


async def _sweep_orphans(conn: psycopg.AsyncConnection[dict[str, Any]]) -> list[str]:
    """Log agent-authored topic pages with no inbound [article:…] citation.

    Counts citations across *all* revisions (no current-revision filter) — so
    this is conservative: a topic page cited only by a since-rewritten revision
    of some other page won't be flagged. It's a `log.warning` only; over- vs
    under-reporting an orphan here is low-stakes, and conservative beats
    false-flagging.
    """
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
    # Links use `[`slug`](article:slug)` — the `article:` URL scheme is for a
    # renderer/UI to route, NOT the inline-citation grammar (`[article:slug]`,
    # bare-bracketed) that parseInlineCitations / wiki_regen recognise. That's
    # fine: the `index` page is excluded from wiki_search_index / wiki_kg, so
    # its links are never parsed as citations.
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
# Neo4j-backed sweeps (Phase 4b-ii)
# ---------------------------------------------------------------------------


def _slugify(value: str, max_len: int = 64) -> str:
    """Normalise a KG identifier so it fits the `knowledge_articles.slug` shape.

    `slug` allows `[A-Za-z0-9_./-]`. Substitute everything else with `-`,
    collapse runs, and trim. Lowercases for stability.
    """
    s = _SLUG_SAFE_RE.sub("-", value.strip().lower())
    s = re.sub(r"-{2,}", "-", s).strip("-/")
    return s[:max_len] if len(s) > max_len else s


def _contradiction_slug(subject_label: str, subject_id_value: str, predicate: str) -> str:
    """Deterministic, slug-safe contradiction page slug.

    Shape: `contradiction/<subject_label>/<subject_id_slug>/<predicate_slug>`.
    Stable across runs so the linter's `ON CONFLICT DO NOTHING` is correct.
    """
    return (
        "contradiction/"
        f"{_slugify(subject_label, 32)}/"
        f"{_slugify(subject_id_value, 48)}/"
        f"{_slugify(predicate, 32)}"
    )


async def _sweep_stale_citations(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    neo4j_client: Any,
    limit: int,
) -> int:
    """Re-dirty current pages whose cited `:Fact` nodes have been invalidated.

    Belt-and-braces backstop for the event-driven path the `wiki_pages`
    projector already runs. Idempotent: only flips pages that aren't already
    `dirty=true`. Caps writes at `limit` per sweep.

    Returns the number of pages re-dirtied.
    """
    # 1. Collect every (article_id, fact_id) pair the linter cares about.
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT ka.id::text AS article_id, ka.slug, c.cite_ref AS fact_id
              FROM knowledge_article_citations c
              JOIN knowledge_articles ka ON ka.id = c.article_id
             WHERE ka.status = 'current'
               AND ka.dirty = false
               AND c.cite_kind = 'fact'
               AND c.revision = ka.revision
            """,
        )
        cite_rows = await cur.fetchall()
    if not cite_rows:
        return 0

    fact_ids = sorted({r["fact_id"] for r in cite_rows if r["fact_id"]})
    # 2. Ask Neo4j which of those :Fact nodes are no longer trustworthy.
    invalidated: set[str] = set()
    if fact_ids:
        async with neo4j_client.session() as sess:
            result = await sess.run(
                """
                UNWIND $fact_ids AS fid
                MATCH (f:Fact {fact_id: fid})
                OPTIONAL MATCH (h)-[r:CITES]->(f)
                WITH f,
                     collect(r) AS edges,
                     [e IN collect(r) WHERE e.invalidated_at IS NULL] AS live_edges
                WHERE f.invalidated_at IS NOT NULL
                   OR (size(edges) > 0 AND size(live_edges) = 0)
                RETURN f.fact_id AS fact_id
                """,
                fact_ids=fact_ids,
            )
            async for record in result:
                invalidated.add(str(record["fact_id"]))
    if not invalidated:
        return 0

    # 3. Mark each article whose citation set intersects the invalidated set.
    stale_articles: dict[str, list[str]] = {}
    for r in cite_rows:
        if r["fact_id"] in invalidated:
            stale_articles.setdefault(r["article_id"], []).append(r["slug"])
    if not stale_articles:
        return 0

    re_dirtied = 0
    for article_id, _slugs in list(stale_articles.items())[:limit]:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE knowledge_articles
                   SET dirty        = true,
                       dirty_reason = 'lint:stale_citation',
                       updated_at   = NOW()
                 WHERE id = %s::uuid AND dirty = false
                """,
                (article_id,),
            )
            re_dirtied += cur.rowcount
    await conn.commit()
    if re_dirtied:
        log.info("wiki-linter: re-dirtied %d page(s) with stale fact citations", re_dirtied)
    return re_dirtied


async def _sweep_contradictions(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    neo4j_client: Any,
    min_objects: int,
    limit: int,
) -> int:
    """Create `contradiction/<slug>` stubs for `(subject, predicate)` groups
    with ≥`min_objects` distinct active object values in the KG.

    Stub `entity_ref` carries the subject + predicate + the list of fact_ids
    on the disagreeing side so `wiki_regen._ctx_contradiction` can rebuild
    the `claim_a` / `claim_b` shape the `wiki.contradiction` prompt expects.
    """
    # 1. Find (subject, predicate) groups in Neo4j with multiple active objects.
    groups: list[dict[str, Any]] = []
    async with neo4j_client.session() as sess:
        result = await sess.run(
            """
            MATCH (f:Fact)
            WHERE f.invalidated_at IS NULL
              AND f.subject_label IS NOT NULL
              AND f.subject_id_value IS NOT NULL
              AND f.predicate IS NOT NULL
              AND f.object_id_value IS NOT NULL
            WITH f.subject_label   AS subject_label,
                 f.subject_id_value AS subject_id_value,
                 f.predicate        AS predicate,
                 collect(DISTINCT f.object_id_value) AS objects,
                 collect(f.fact_id) AS fact_ids
            WHERE size(objects) >= $min_objects
            RETURN subject_label, subject_id_value, predicate, objects, fact_ids
             LIMIT $limit
            """,
            min_objects=min_objects,
            limit=limit * 4,  # buffer; we drop dupes below
        )
        async for record in result:
            groups.append(
                {
                    "subject_label": str(record["subject_label"]),
                    "subject_id_value": str(record["subject_id_value"]),
                    "predicate": str(record["predicate"]),
                    "objects": [str(o) for o in record["objects"]],
                    "fact_ids": [str(fid) for fid in record["fact_ids"]],
                }
            )
    if not groups:
        return 0

    created = 0
    for g in groups:
        if created >= limit:
            break
        slug = _contradiction_slug(g["subject_label"], g["subject_id_value"], g["predicate"])
        # Validate the slug — _slugify might produce an empty segment for
        # exotic inputs; skip those rather than insert a malformed row.
        if not slug or slug.endswith("/") or "//" in slug:
            log.warning("wiki-linter: skipping malformed contradiction slug for subject=%s predicate=%s",
                        g["subject_id_value"], g["predicate"])
            continue
        entity_ref = {
            "label": "Contradiction",
            "id_property": "slug",
            "id_value": slug,
            "subject_label": g["subject_label"],
            "subject_id_value": g["subject_id_value"],
            "predicate": g["predicate"],
            "objects": g["objects"][:32],
            "fact_ids": g["fact_ids"][:32],
        }
        title = (
            f"Contradiction: {g['subject_label']} {g['subject_id_value']} "
            f"— {g['predicate']} ({len(g['objects'])} distinct objects)"
        )
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO knowledge_articles
                  (slug, kind, title, body_md, entity_ref, group_id, maturity,
                   dirty, dirty_reason, created_by)
                VALUES (%s, 'contradiction', %s, '', %s::jsonb, %s,
                        'EXPLORATORY', true, 'lint:contradiction', %s)
                ON CONFLICT (slug) DO NOTHING
                """,
                (slug, title[:400], json.dumps(entity_ref), _SYSTEM, _SYSTEM),
            )
            created += cur.rowcount
    await conn.commit()
    if created:
        log.info("wiki-linter: created %d contradiction stub(s)", created)
    return created


# ---------------------------------------------------------------------------
# Daemon loop
# ---------------------------------------------------------------------------


def _make_neo4j_client() -> Any | None:
    """Instantiate `Neo4jClient` from env, or return None if NEO4J_URI is unset.

    The linter must keep running its pure-Postgres sweeps even in environments
    that don't deploy a KG (the chemistry profile is optional). The two
    Neo4j-backed sweeps are no-ops when the driver is absent.
    """
    if not os.environ.get("NEO4J_URI"):
        log.info("wiki-linter: NEO4J_URI unset; skipping stale-citation + contradiction sweeps")
        return None
    try:
        # Lazy import keeps the test suite (no neo4j package) green.
        from services.projectors.common.neo4j_client import Neo4jClient
        return Neo4jClient.from_env()
    except Exception as exc:  # noqa: BLE001 — fail-open
        log.warning("wiki-linter: could not initialise Neo4j client (%s); skipping KG sweeps", exc)
        return None


async def run_once(settings: Settings) -> dict[str, Any]:
    stats: dict[str, Any] = {
        "stubs_created": 0, "orphans": 0, "index_rebuilt": False,
        "stale_redirtied": 0, "contradictions_created": 0,
        "neo4j_enabled": False, "errors": 0,
    }
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

        # Neo4j-backed sweeps — skip cleanly when the driver isn't configured.
        neo4j_client = _make_neo4j_client()
        if neo4j_client is not None:
            stats["neo4j_enabled"] = True
            try:
                stats["stale_redirtied"] = await _safe(
                    "stale_citations",
                    _sweep_stale_citations(conn, neo4j_client, settings.wiki_linter_max_stale_per_run),
                ) or 0
                stats["contradictions_created"] = await _safe(
                    "contradictions",
                    _sweep_contradictions(
                        conn, neo4j_client,
                        settings.wiki_linter_contradiction_min_objects,
                        settings.wiki_linter_max_contradictions_per_run,
                    ),
                ) or 0
            finally:
                try:
                    await neo4j_client.close()
                except Exception:  # noqa: BLE001
                    pass

        # Index rebuild last — it now reflects any new contradiction stubs.
        stats["index_rebuilt"] = bool(await _safe("index_rebuild", _rebuild_index(conn)))

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        try:
            await _append_log(
                conn,
                f"## [{today}] lint | {stats['stubs_created']} stub(s) created · "
                f"{stats['orphans']} orphan(s) · index {'rebuilt' if stats['index_rebuilt'] else 'unchanged'}"
                + (f" · {stats['stale_redirtied']} stale-redirtied" if stats["stale_redirtied"] else "")
                + (f" · {stats['contradictions_created']} contradiction(s)" if stats["contradictions_created"] else "")
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
