# Plan: Knowledge-wiki projection layer

ADR: `docs/adr/012-knowledge-wiki-projection.md`. This doc holds (1) the full
options analysis behind the decision and (2) the phased implementation plan.

## Why

ChemClaw stores knowledge in three layers — Postgres canonical ledger (event-
sourced), Neo4j bi-temporal KG (Graphiti-style facts with confidence tiers +
provenance), pgvector semantic index — but has **no human-readable, navigable,
maintained surface over any of it**. Knowledge is shredded into facts / chunks /
rows; synthesis is re-derived every query and evaporates into chat history
(`research_reports` is the closest persisted form, but write-once, per-user,
unlinked, never updated); the only curation primitive is the maturity tier
(an attribute on rows, not an editable document). The 2026 "LLM wiki" pattern
(Karpathy; "LLM Wiki v2"), GraphRAG's entity/community summary pages, and the
"markdown vault for canonical knowledge + graph/vector for retrieval" consensus
all close exactly this gap.

Key reframing: **a wiki and the KG are dual representations, not either/or.**
KG = atom store (machine-queryable, time-sliceable, contradiction-aware,
provenance per edge). Wiki = molecule layer (human-readable, navigable,
synthesized). ChemClaw is unusually well-placed for this — it already has a real
graph *and* an event log to drive the projection.

## Options analysis

### Option A — wiki as a first-class projection layer  ✅ chosen

New canonical `knowledge_articles` (+ `knowledge_article_revisions` +
`knowledge_article_citations`) tables, event-sourced and RLS-scoped like the
rest of the ledger. A `wiki_pages` projector (re)generates entity + synthesis
pages from KG / document / hypothesis / artifact / campaign events
(mark-dirty + debounced batch + on-read regen). A `wiki_kg` projector mirrors
pages as `:WikiPage` nodes with `:SUMMARIZES` / `:GROUNDS` edges. A
`wiki_search_index` projector chunks + embeds article bodies into the existing
pgvector space. A nightly `wiki_linter` cron. Agent builtins (`read_article`,
`list_articles`, `upsert_article`, `request_article` + article hits in
`search_knowledge` / `retrieve_related`). Admin maturity-promotion route.
`/wiki` slash verb + `wiki_curator` skill. Feature-flagged (`wiki.enabled`),
tuned via `config_settings`, prompts in `prompt_registry`.

* **Pros**: agent reads one page instead of N retrievals (token + quality win),
  every claim citation-traced, contradictions get a home, human edits become a
  first-class `expert_validated` input, zero churn on the KG / event spine
  (it's another replayable derived view).
* **Cons / risks**: LLM cost (mitigated: debounce + per-hour cap + cheap model
  + on-read laziness + kill switch); stale pages (mitigated: `stale` banner +
  stale-citation linter + on-read regen); human/agent edit conflicts
  (mitigated: `human:*` block convention + `pre_tool` guard + revisions);
  vector bloat (mitigated: delete superseded-revision chunks + sibling table);
  taxonomy scope creep (mitigated: v1 kinds only; ADR amendment for new
  auto-kinds).

### Option B — markdown-first, KG demoted to a derived index  ❌ rejected

Pages become the system of record for synthesized knowledge; the KG is rebuilt
from page frontmatter/links. Closest to pure Karpathy / GraphRAG. **Rejected**:
loses bi-temporal rigor on facts, the deterministic projector-replay invariant,
and the per-row RLS story; the whole architecture (and CLAUDE.md) is built
around A-on-C; large migration. The KG is not the problem; the missing wiki
layer is.

### Option C — adopt an off-the-shelf wiki engine  ❌ rejected

Semantic MediaWiki / Wikibase / Outline. The *J. Cheminformatics* 2025 paper
("Implementation of an open chemistry knowledge base with a Semantic Wiki")
shipped on SMW + Page Forms. **Rejected**: another service to operate; SMW is
GPL (we already carry the Neo4j GPL constraint and care about it); the
tenant/RLS model doesn't map; permanent sync tax keeping it consistent with the
KG. Reimplementing the ~20 % of SMW we actually need (Option A) is cleaner than
integrating 100 % of it.

### Option D — git-backed markdown vault  ❌ rejected

The literal Karpathy setup: a repo of `.md` files the agent commits to, BM25 /
`qmd` for search. **Rejected**: a git repo is one tenant (no multi-tenant /
RLS); no transactional consistency with the event log; the agent runs in
ephemeral containers without a persistent checkout; audit/observability
regresses vs Postgres. Fine for a single-user research assistant; wrong for
ChemClaw's multi-tenant, GxP-adjacent posture.

## Architecture

```
                          ingestion_events  (NOTIFY)
   kg_* fact writes ──┐        │
   document_ingested ─┤        │
   hypothesis_* ──────┼──▶  ┌──┴────────────────┐
   fact_invalidated ──┤     │ wiki_pages        │  mark dirty → debounced
   synthesis_camp_* ──┘     │   projector       │  LLM regen (via LiteLLM,
                            └──┬────────────────┘  prompt mode wiki.synthesis)
                               │ writes
                               ▼
        ┌──────────────────────────────────────────────┐
        │ Postgres: knowledge_articles                 │
        │           knowledge_article_revisions        │
        │           knowledge_article_citations        │
        └───┬───────────────┬───────────────┬──────────┘
            │ (emits knowledge_article_created / _revised / _archived)
            ▼               ▼               ▼
   ┌────────────────┐  ┌──────────────┐  ┌─────────────────────┐
   │ wiki_kg        │  │ wiki_search_ │  │ wiki_linter (cron)  │
   │  projector     │  │  index proj. │  │  nightly: stale-    │
   │  :WikiPage +   │  │  chunk+embed │  │  citation, orphan,  │
   │  :SUMMARIZES/  │  │  → pgvector  │  │  missing-page,      │
   │  :GROUNDS      │  │  (wiki_chunks│  │  contradiction-page,│
   │  in Neo4j      │  │   source)    │  │  index/log rebuild  │
   └────────────────┘  └──────────────┘  └─────────────────────┘
            ▲                  ▲
            │                  │  search_knowledge / retrieve_related
            │                  │  now return `wiki` hits too
   ┌────────┴──────────────────┴────────────────────────────────┐
   │ agent-claw builtins:                                        │
   │   read_article · list_articles · upsert_article ·           │
   │   request_article  (+ wiki hits folded into search)         │
   │ /wiki slash verb → wiki_curator skill                       │
   │ pre_tool hook: wiki-human-block-guard                       │
   │ PATCH /api/articles/:id (human edit) → expert_validated     │
   │ POST /api/admin/articles/:id/maturity (guardAdmin+audit)    │
   └─────────────────────────────────────────────────────────────┘
```

## Data model

See ADR 012 for column-level detail. Three tables in `db/init/58_knowledge_wiki.sql`:

* **`knowledge_articles`** — head version per `slug` (UNIQUE). `kind ∈
  {compound, reaction_family, nce_project, synthesis_campaign, document_digest,
  researcher, topic, glossary, index, log, contradiction}`. `nce_project_id`
  NULL ⇒ org-wide (authenticated-session gate, like `compounds`/`documents`),
  set ⇒ project-scoped (`EXISTS user_project_access`). `maturity` reuses
  EXPLORATORY/WORKING/FOUNDATION. `dirty` + `dirty_reason` drive regen.
  `has_human_edits` protects `human:*` blocks. Bi-temporal `valid_from` /
  `superseded_at` (matches `artifacts`). `etag` for optimistic concurrency.
* **`knowledge_article_revisions`** — append-only, one row per body change;
  `author_kind ∈ {agent, human, projector, linter}`; full title/summary/body
  snapshot; `change_note`. `(article_id, revision)` UNIQUE.
* **`knowledge_article_citations`** — per-*revision* citation set;
  `cite_kind ∈ {fact, chunk, experiment, reaction, hypothesis, artifact,
  document, article}`, `cite_ref` text. Index on `(cite_kind, cite_ref)` for
  the reverse lookup (fact invalidated → mark citing pages dirty).

Triggers: `set_updated_at`; `emit_knowledge_article_event()` →
`knowledge_article_created` / `_revised` / `_archived` into `ingestion_events`;
catalog rows in `ingestion_event_catalog`. RLS + FORCE on all three tables;
grants to `chemclaw_app` (SELECT/INSERT/UPDATE on articles, SELECT/INSERT on
revisions+citations) and `chemclaw_service` (ALL).

## Page taxonomy (v1)

Auto-generated by `wiki_pages`: `compound/<inchikey>` (org-wide),
`reaction-family/<rxno>` (org-wide), `project/<internal_id>` (project),
`campaign/<uuid>` (project), `document/<sha256-prefix>` (org-wide).
Synthesis pages: `index`, `log`, `glossary`, `contradiction/<slug>` (maintained
by `wiki_pages`/`wiki_linter`); `topic/<slug>` (agent- or human-created, the
only kind humans typically create from scratch). New *auto-generated* kinds
require an ADR 012 amendment; human `topic/` pages are unconstrained.

## Regeneration model — mark-dirty + debounced batch + on-read

1. Backing event → resolve affected slug(s) via `entity_ref` + citation
   reverse-index → `dirty = true`, `dirty_reason = <event_type>`; new entities
   get a deterministic stub page (so there's always something to read).
2. Debounced batch (`wiki.regen_debounce_seconds=300`, `wiki.regen_max_per_hour=200`,
   `wiki.regen_model`=Haiku-class via central LiteLLM, prompt mode
   `wiki.synthesis`): pull current KG facts + relevant chunks + hypotheses +
   artifacts → re-synthesise body with inline `[fact:…]` citations → preserve
   `human:*` blocks verbatim → write new revision + fresh citation set →
   recompute `confidence_score` (recency/tier-weighted mean of cited facts) →
   clear `dirty` → append `log` entry.
3. `read_article` on a `dirty` page triggers a synchronous single-page regen if
   `wiki.regen_on_read` (bounded by `wiki.regen_on_read_timeout_ms`), else
   returns the stale body with a `stale: true` banner + dirty reason.

## Human edits

`PATCH /api/articles/:id` (RLS-scoped): replace body, `has_human_edits=true`,
bump `revision`+`etag`, write `knowledge_article_revisions` (`author_kind='human'`),
emit `knowledge_article_revised`. Convention: authoritative prose wrapped in
`<!-- human:begin owner=<entra-id> --> … <!-- human:end -->`. `wiki_pages`
copies `human:*` blocks through verbatim, may add `<!-- agent:note -->`
*around* them, never inside. `wiki_kg` writes human-owned claims as
`expert_validated` facts (so `check_contradictions` / the confidence ensemble
treat them right). The `wiki-human-block-guard` `pre_tool` hook rejects
`upsert_article` writes that touch a `human:*` block or over-promote `maturity`.

## Phases (each = its own reviewed PR, merged to `main`)

### Phase 0 — design + data model  ✅ (this PR)

* `docs/adr/012-knowledge-wiki-projection.md`
* `docs/plans/knowledge-wiki-projection.md` (this file)
* `db/init/58_knowledge_wiki.sql` — tables, RLS+FORCE, triggers, event-catalog
  rows, grants, `schema_version` row.
* `BACKLOG.md` — Phases 1–5 logged.
* **Done when**: `make db.init` applies cleanly on a fresh DB; `SELECT * FROM
  schema_version WHERE filename = '58_knowledge_wiki.sql'` returns a row;
  inserting a `knowledge_articles` row emits a `knowledge_article_created`
  `ingestion_events` row (manual smoke). No code yet — the schema is inert
  until Phase 1, by design.

### Phase 1 — agent read/write surface (no projector yet)  ✅ done

* `services/agent-claw/src/tools/builtins/_wiki_shared.ts` (schemas, the
  inline-citation parser, `assertWikiEnabled`, row→view mappers) +
  `{read_article,list_articles,upsert_article,request_article}.ts` — RLS via
  `withUserContext`, registered in `bootstrap/dependencies.ts`,
  `MIN_EXPECTED_BUILTINS` 86→90. `upsert_article` restricts to
  agent-authorable kinds (`topic`/`glossary`/`contradiction`), refuses to
  overwrite `has_human_edits` pages, parses inline `[fact:…]`/`[chunk:…]`
  citations into `knowledge_article_citations`, writes a `knowledge_article_revisions`
  row (`author_kind='agent'`). `request_article` creates/marks-dirty a stub.
* `pre_tool` hook `wiki-human-block-guard` (`src/core/hooks/`, `hooks/*.yaml`,
  `BUILTIN_REGISTRARS`, `MIN_EXPECTED_HOOKS` 24→25) — denies an `upsert_article`
  body that authors a `<!-- human:begin ... -->` marker.
* `src/routes/knowledge-articles.ts` — `GET /api/articles`, `GET /api/articles/:id`
  (`?revision=N` for history), `PATCH /api/articles/:id` (human edit: sets
  `has_human_edits`, bumps revision+etag, writes a revision row, parses
  citations; 409 on etag conflict, 404 not found, 404 when `wiki.enabled` off);
  wired in `bootstrap/routes.ts`.
* `feature_flags` row `wiki.enabled` (`db/init/22_feature_flags.sql`, default
  OFF; env fallback `WIKI_ENABLED`). Builtins call `assertWikiEnabled` first.
* Vitest: `tests/unit/builtins/knowledge_articles.test.ts` (feature gate,
  kind guard, human-block guard, SQL touchpoints, human-edits refusal),
  `tests/unit/hooks-wiki-human-block-guard.test.ts`,
  `tests/unit/knowledge-articles-route.test.ts` (200/400/404/409 paths);
  `hook-loader-coverage.test.ts` counts bumped to 25.
* **Done**: `npm test --workspace services/agent-claw` → 1495 passed | 12
  skipped; `npm run typecheck` ok; `npm run lint` ok. (DB-backed end-to-end
  is exercised by the testcontainer integration suite — self-skips without
  Docker, same as the rest.)

### Phase 2 — `wiki_pages` projector (mark-dirty + batch regen)

* `services/projectors/wiki_pages/` — `BaseProjector` subclass; consumes
  `kg_fact_written` / `fact_invalidated` / `document_ingested` /
  `hypothesis_*` / `synthesis_campaign_*` (exact event names per
  `ingestion_event_catalog`); resolves slugs; marks dirty / creates stubs; runs
  the debounced LLM regen loop (LiteLLM, prompt mode `wiki.synthesis`);
  recomputes `confidence_score`; appends `log`.
* `config_settings` rows for the `wiki.regen.*` knobs; `prompt_registry` row
  `wiki.synthesis` (in `db/seed/02_prompt_registry.sql`).
* `docker-compose.yml` + `infra/helm/` wiring (profile flag).
* Idempotency: deterministic stub bodies; `ON CONFLICT` guards; replay-safe
  (`DELETE FROM projection_acks WHERE projector_name='wiki_pages'` re-derives).
* pytest: stub creation, dirty-marking, regen writes a revision + citations,
  human-block preservation, replay idempotency (LiteLLM mocked).
* **Done when**: ingesting a document and writing a `:Compound` fact produces a
  `compound/<inchikey>` page with cited facts; invalidating a cited fact marks
  the page dirty; the page regenerates.

### Phase 3 — `wiki_kg` + `wiki_search_index` projectors

* `services/projectors/wiki_kg/` — direct-driver (uses
  `services/projectors/common/neo4j_client.py`); `:WikiPage` MERGE,
  `:SUMMARIZES` / `:GROUNDS` edges, bi-temporal close on revision change /
  archive (à la `kg_hypotheses`).
* `services/projectors/wiki_search_index/` — re-chunk (heading-aware, same
  chunker as `doc_ingester`), embed via `mcp-embedder`, upsert into a sibling
  `wiki_chunks` table (`db/init/59_wiki_chunks.sql`) tagged `source_type='wiki'`
  + `article_id`/`slug` backlink; delete superseded-revision chunks in the same
  txn.
* Extend `search_knowledge` / `retrieve_related` to include `wiki` hits in the
  RRF; extend `query_provenance` to walk `:Fact → GROUNDS ← :WikiPage`.
* Compose + helm wiring; pytest + vitest.
* **Done when**: `search_knowledge("…")` returns a wiki page among the hits;
  `query_provenance(fact_id)` lists the page that asserts it.

### Phase 4 — linter cron + admin route + slash verb + skill

* `services/optimizer/wiki_linter/` (reuses the `services/optimizer/*` cron
  pattern): stale-citation, orphan, missing-page, contradiction-page,
  index/log rebuild; everything logged on the `log` page + structured logger.
* `POST /api/admin/articles/:id/maturity` — `guardAdmin`, `appendAudit`,
  cache-bust; runbook `docs/runbooks/knowledge-wiki-curation.md`.
* `/wiki` slash verb (slash parser) + `skills/wiki-curator/SKILL.md` +
  `skill_library` seed row.
* `prompt_registry` row `wiki.contradiction`.
* **Done when**: a nightly lint run flags a stale page and rebuilds `index`; an
  admin can promote a page to FOUNDATION (audited); `/wiki <slug>` opens the
  curator skill.

### Phase 5 — polish: confidence wiring, observability, docs

* Wire page `confidence_score` into the existing confidence-ensemble telemetry
  (`logEnsembleSignals`) where a page is used as evidence.
* Grafana panel(s): regen rate, dirty-page backlog, lint findings, LLM token
  spend for `wiki.synthesis`.
* CLAUDE.md "Status" + "Required patterns" updates; `docs/PARITY.md` if
  relevant; ADR 012 status note.
* `make test-counts` refresh.
* **Done when**: dashboards live; CLAUDE.md reflects the feature; ADR marked
  shipped.

## Open questions to settle as we go (not blockers for Phase 0)

1. `wiki_chunks` sibling table vs reusing `document_chunks` with a `source_type`
   discriminator — plan assumes a sibling table (cleaner `source_type` filters);
   revisit in Phase 3.
2. Exact backing event names — Phase 2 reads `ingestion_event_catalog` to pin
   them; `kg_*` projectors may need to *emit* a `kg_fact_written` event if one
   doesn't exist yet (today the KG is a derived view that doesn't re-emit).
   If so, that's a small addition to the `kg_*` projectors, logged here.
3. Whether `compound/` pages should be per-org-wide-only or also have
   project-scoped overlays (a project might annotate a shared compound). Plan
   assumes org-wide only for v1; a project annotation goes on the `project/`
   page or a `topic/` page.
4. Debounce implementation — in-projector timer vs an `agent_todos`-style work
   table vs a small `wiki_regen_queue` table. Plan leans on a `dirty` flag +
   the projector's own loop (simplest, replay-safe); revisit if regen volume
   demands a queue.
5. Human-block granularity — single fenced block per owner vs multiple named
   blocks. Plan starts with multiple named `human:begin owner=… name=…` blocks;
   the guard hook keys on `human:*` regardless.
