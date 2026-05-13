# Runbook — knowledge-wiki curation

How to enable the knowledge-wiki layer, observe its state, drive
curation (human and agent), promote / demote maturity, replay
projectors, and disable the feature when needed.

See ADR 012 (`docs/adr/012-knowledge-wiki-projection.md`) for the
design rationale and the plan
(`docs/plans/knowledge-wiki-projection.md`) for the phase breakdown.

## Enable the feature

The wiki is feature-flagged. Default is **OFF** — the four agent
builtins (`read_article`, `list_articles`, `upsert_article`,
`request_article`) are always registered but reject calls until the
flag flips, and the `/api/articles*` HTTP surface returns
`404 feature_disabled`.

```sh
# Flip the flag on globally:
curl -X POST -H 'x-user-entra-id: <admin-entra-id>' \
  -H 'content-type: application/json' \
  -d '{"enabled": true, "description": "knowledge wiki (ADR 012)"}' \
  http://localhost:3101/api/admin/feature-flags/wiki.enabled
```

Scope-rule examples (org / project / specific users): see
`docs/runbooks/local-dev.md` or `POST /api/admin/feature-flags/:key`
in the admin docs. The bootstrap fallback is `WIKI_ENABLED=true` in
`.env`; prefer the DB flag for anything beyond local dev.

## Run the projectors and the regen daemon

```sh
# Postgres → knowledge_articles + dirty flag (always-on consumer).
make run.wiki-pages

# Postgres → Neo4j (mirrors articles as :WikiPage nodes).
make run.wiki-kg

# Postgres → wiki_chunks (BGE-M3 embeddings for search_knowledge).
make run.wiki-search-index

# Periodic catalog sweep (missing-page stubs, orphan logging, index).
make run.wiki-linter

# LLM-cost daemon — synthesises page bodies for dirty entity pages.
# Default OFF in helm; enable with `projectors.wikiRegen.enabled=true`.
make run.wiki-regen
```

In docker-compose the four projectors + the regen daemon run under the
`full` profile:

```sh
docker compose --profile full up -d wiki-pages wiki-kg wiki-search-index wiki-linter
# Enable the regen daemon explicitly — it costs LLM tokens:
docker compose --profile full up -d wiki-regen
```

## Observe wiki state

```sql
-- How many pages, by kind + status?
SELECT kind, status, COUNT(*) FROM knowledge_articles GROUP BY 1, 2 ORDER BY 1, 2;

-- Dirty pages waiting on the regen daemon:
SELECT slug, kind, dirty_reason, updated_at FROM knowledge_articles
 WHERE dirty = true ORDER BY updated_at DESC LIMIT 50;

-- Pages a human has edited (authoritative; agent cannot overwrite):
SELECT slug, kind, revision, last_edited_by, updated_at FROM knowledge_articles
 WHERE has_human_edits = true ORDER BY updated_at DESC;

-- Top-50 most-cited pages (popularity hint):
SELECT a.slug, COUNT(*) AS citing_revisions
  FROM knowledge_article_citations c
  JOIN knowledge_articles a ON a.id = c.article_id
 WHERE c.cite_kind = 'article'
 GROUP BY a.slug ORDER BY 2 DESC LIMIT 50;
```

The corresponding Grafana panel ("Knowledge wiki — coverage &
freshness") rolls these up; Loki captures the regen daemon's
`info`-level lines.

## Curate a page

Three curation paths, in increasing trust:

| Path | Who | Effect on `maturity` | Authoritative? |
|---|---|---|---|
| `/wiki <query>` | agent | none | yes, but agent-authorable kinds only (topic / glossary / contradiction) |
| `PATCH /api/articles/:id` | human | none (sets `has_human_edits=true`) | yes — projector copies through, agent cannot overwrite |
| `POST /api/admin/articles/:id/maturity` | admin | sets `EXPLORATORY` / `WORKING` / `FOUNDATION` | yes — admin-only, audited |

### Agent: `/wiki`

```
/wiki What are the common conditions for Buchwald-Hartwig amination on aryl chlorides at scale?
```

The `wiki_curator` skill (`skills/wiki-curator/SKILL.md`) is
activated. The agent reads existing pages, drafts a new
`topic/<slug>` or `glossary/<term>` if nothing exists, and cites
inline using the `[fact:<uuid>] [experiment:<id>] [reaction:<id>]
[chunk:<id>] [hypothesis:<id>] [artifact:<id>] [document:<sha>]
[article:<slug>]` forms. The skill is forbidden by the
`wiki-human-block-guard` pre_tool hook from authoring
`<!-- human:begin … -->` markers — only humans can.

### Human: `PATCH /api/articles/:id`

```sh
# Read the current page (capture its etag):
curl -H 'x-user-entra-id: <you>' \
  http://localhost:3101/api/articles/<article-id> | jq

# Edit (optimistic-concurrency via expected_etag):
curl -X PATCH -H 'x-user-entra-id: <you>' \
  -H 'content-type: application/json' \
  -d '{
        "body_md": "...\n<!-- human:begin: caveat -->\n\nThe yield reported in [reaction:RXN-0123] is for 5 mol% catalyst — at 1 mol% (which we standardised on in 2026-Q1) you get ~12% lower.\n\n<!-- human:end -->\n...",
        "change_note": "added the 2026-Q1 catalyst-loading caveat",
        "expected_etag": 7
      }' \
  http://localhost:3101/api/articles/<article-id>
```

- `has_human_edits` flips to `true`. The `wiki_regen` daemon refuses
  to overwrite the page going forward; it only updates the
  scaffolding outside the `<!-- human:begin … -->` blocks (and even
  then only on the next dirty sweep).
- A revision row is written (`author_kind='human'`).
- Stale `expected_etag` → `409 etag_conflict`. Re-read, re-edit.

### Admin: promote / demote maturity

```sh
# Promote to WORKING:
curl -X POST -H 'x-user-entra-id: <admin>' \
  -H 'content-type: application/json' \
  -d '{"tier": "WORKING", "reason": "two independent sources cited"}' \
  http://localhost:3101/api/admin/articles/<article-id>/maturity
```

The route writes an `admin_audit_log` row
(`action='knowledge_article.maturity'`) with the before / after
tiers and bumps the page's `etag` (but **not** its `revision` — the
body did not change). Demotion uses the same call with the lower
tier; demoting `FOUNDATION → EXPLORATORY` is allowed and audited.

## Replay a projector

All projectors / daemons are event-sourced via `ingestion_events` (or
custom NOTIFY channels for direct-driver projectors). To rebuild from
scratch:

```sql
-- wiki_pages projector (the postgres-side stub creator + dirty marker):
DELETE FROM projection_acks WHERE projector_name = 'wiki_pages';
-- (Optional) wipe all article rows; only do this if you want a clean rebuild.
-- TRUNCATE knowledge_article_citations, knowledge_article_revisions, knowledge_articles CASCADE;

-- wiki_kg projector (Neo4j :WikiPage mirror):
DELETE FROM projection_acks WHERE projector_name = 'wiki_kg';
-- Then in Neo4j: MATCH (w:WikiPage) DETACH DELETE w;

-- wiki_search_index projector (BGE-M3 embeddings on wiki_chunks):
DELETE FROM projection_acks WHERE projector_name = 'wiki_search_index';
DELETE FROM wiki_chunks;
```

Restart the projector container; it replays from event 0. Handlers
are idempotent so a partial rebuild is safe.

## Adjust regen knobs

```sql
-- Poll cadence (default: 300 s):
SELECT bootstrap_config_setting('wiki.regen.poll_interval_seconds', '600', NULL);

-- Per-hour write cap per slug (default: 4):
SELECT bootstrap_config_setting('wiki.regen.rate_limit_per_hour', '2', NULL);

-- LLM model override (defaults to the central LiteLLM-routed wiki model):
SELECT bootstrap_config_setting('wiki.regen.model', 'gpt-4o-mini', NULL);
```

The daemon reads these on its next loop iteration (no restart needed
for env-mirrored knobs; restart for in-process cached ones if you
change behaviour mid-run).

## Disable the feature

Flip the flag off:

```sh
curl -X POST -H 'x-user-entra-id: <admin>' \
  -H 'content-type: application/json' \
  -d '{"enabled": false, "description": "knowledge wiki (ADR 012)"}' \
  http://localhost:3101/api/admin/feature-flags/wiki.enabled
```

The four builtins start returning errors; `/api/articles*` returns
`404 feature_disabled`; `search_knowledge` no longer mixes the wiki
arm into the RRF. The projectors / daemons continue to run unless
also stopped (`docker compose stop wiki-pages wiki-kg
wiki-search-index wiki-linter wiki-regen`) — keeping them running is
fine, the data stays consistent and the flag flip is reversible.

## Common failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| Page stays `dirty=true` for hours | `wiki_regen` not running, or rate-limited on that slug | Check `docker ps`; lower `wiki.regen.rate_limit_per_hour` or wait |
| `409 etag_conflict` on PATCH | Stale `expected_etag` (another writer ran since you read) | Re-fetch, merge your edit, retry |
| `404 feature_disabled` on `/api/articles*` | `wiki.enabled` flag is off | Flip via admin API (above) |
| Agent writes `compound/<inchikey>` page | Bug — agent must use `request_article` for entity-backed kinds | Reproduce, log, file a backlog entry, check the skill rules in `skills/wiki-curator/SKILL.md` |
| `wiki-human-block-guard` denies an agent call | Agent body contained `<!-- human:begin … -->` | Expected — agent must not author those markers |
| Search hits don't include wiki pages | `include_wiki: false` or the projector hasn't indexed the page yet | Re-call with `include_wiki: true`; check `wiki_chunks` for the page's `article_id` |
