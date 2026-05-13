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

### Phase 2a — `wiki_pages` projector (mark-dirty + stub creation, no LLM)  ✅ done

* `services/projectors/wiki_pages/` (`main.py` + `__init__.py` + `requirements.txt`
  + `Dockerfile`) — `BaseProjector` subclass; consumes the canonical-knowledge
  events the `kg_*` projectors also consume (`document_ingested`,
  `experiment_imported`, `hypothesis_proposed`/`_status_changed`,
  `synthesis_campaign_created`/`_state_changed`, `fact_invalidated`) — no new
  `kg_fact_written` event needed; reads the canonical row to derive the
  affected entity. `_touch_page` does `INSERT ... ON CONFLICT (slug) DO UPDATE
  SET dirty=true, dirty_reason=…` — creates a `dirty` stub (`body_md=''`,
  `created_by='__system__'`, `group_id='__system__'`) if missing, else just
  re-marks dirty. `fact_invalidated` walks the citation reverse-index and marks
  every citing page `dirty` (`lint:stale_citation`). Replay-safe via
  `projection_acks`; the `knowledge_article_created` event fires once on the
  fresh insert. **Auto-stubs `project/`, `campaign/`, `document/` only** —
  `compound/`, `reaction-family/` auto-stubbing waits for Phase 2b (needs
  reaction-component derivation); for now those pages come from the agent's
  `request_article`.
* `db/init/59_wiki_pages_consumer.sql` — appends `wiki_pages` to the
  `consumed_by` arrays of the seven events (idempotent `array_append` guard).
* `docker-compose.yml` (`wiki-pages` service, `profiles: ["full"]`),
  `infra/helm/values.yaml` + `core-deployments.yaml` (`projectors.wikiPages`),
  `Makefile` (`make run.wiki-pages`).
* pytest: `tests/unit/projectors/test_wiki_pages.py` — stub creation per event
  type, missing-canonical-row → `PermanentHandlerError`, unscoped-hypothesis
  no-op, `fact_invalidated` → citing-page UPDATE, replay issues the identical
  idempotent statement. `.venv/bin/pytest tests/unit/projectors/ -q` → 44
  passed; ruff + mypy clean.
* **Done**: a `document_ingested` / `synthesis_campaign_created` / scoped-
  `hypothesis_proposed` event creates the corresponding stub page; invalidating
  a cited fact marks the citing page dirty; `read_article` returns the stub
  with `stale: true`.

### Phase 2b — the LLM body-synthesis loop  ✅ done

* `services/optimizer/wiki_regen/` (`main.py` + `__init__.py` + `requirements.txt`
  + `Dockerfile`) — a polling daemon (like `session_reanimator`): every
  `WIKI_REGEN_POLL_SECONDS` it picks the oldest `dirty` entity-backed page that
  has been dirty ≥ `WIKI_REGEN_DEBOUNCE_SECONDS` (burst-collapse), gathers a
  compact Postgres context per kind (`document_digest` / `nce_project` /
  `synthesis_campaign` / `compound` / `reaction_family` — one `_ctx_*` builder
  each), reads the `wiki.synthesis` prompt from `prompt_registry` (built-in
  `_FALLBACK_PROMPT` if absent), calls central LiteLLM (`WIKI_REGEN_MODEL`,
  default `claude-haiku-4-5`), parses inline `[fact:…]`/`[experiment:…]`/…
  citations, writes a `knowledge_article_revisions` row (`author_kind='projector'`),
  preserves `human:*` blocks (re-appends any not present under a "Curator notes"
  heading), clears `dirty`, prepends a line to the `log` page. Sliding-window
  rate cap `WIKI_REGEN_MAX_PER_HOUR`; `WIKI_REGEN_BATCH_SIZE` per tick. Race-safe
  (`UPDATE … WHERE dirty` no-ops if a human PATCH / concurrent regen won).
* `db/seed/07_wiki_synthesis_prompt.sql` — seeds `wiki.synthesis` v1 (active);
  the daemon's `_FALLBACK_PROMPT` mirrors it.
* `db/init/60_wiki_regen_config.sql` — `config_settings` catalog rows for
  `wiki.regen.{model,poll_seconds,debounce_seconds,max_per_hour,batch_size}`
  (the daemon reads the matching env vars today — wiring it through
  `ConfigRegistry` + adding `wiki.regen.on_read*` for `read_article` on-read
  regen is a BACKLOG follow-up).
* `docker-compose.yml` (`wiki-regen`, `profiles: ["full"]`),
  `infra/helm/values.yaml` + `core-deployments.yaml` (`projectors.wikiRegen`,
  default `enabled: false` — LLM-cost-incurring), `Makefile` (`make run.wiki-regen`).
* pytest: `tests/unit/optimizer/test_wiki_regen.py` — citation parsing /
  dedup, human-block extraction + re-insertion, `_synthesize` (stubbed httpx:
  body + fence-strip; 4xx/empty → skip; human blocks in payload), the `_ctx_*`
  builders (outline gather; missing-row → `_SkipPage`; bad entity_ref →
  `_PermanentSkip`; project steps+hypotheses), `_apply_regen` (writes
  UPDATE + revision + citations + log; no-op when no longer dirty),
  `_load_prompt` (registry-then-fallback). 12 passed; ruff + mypy clean.
* **Done**: a `dirty` entity-backed stub (`project/`, `campaign/`,
  `document/`, or a `request_article`-created `compound/`) regenerates into a
  cited prose page with a revision row + citation rows; invalidating a cited
  fact re-dirties it and the next tick re-regenerates. Remaining 2b follow-ups
  (compound/reaction-family auto-stubbing, ConfigRegistry wiring, page
  `confidence_score` from cited-fact confidence, on-read regen) are in `BACKLOG.md`.

### Phase 3a — `wiki_kg` projector  ✅ done

* `services/projectors/wiki_kg/` (`main.py` + `__init__.py` + `requirements.txt`
  + `Dockerfile`) — direct-driver (`services/projectors/common/neo4j_client.py`,
  like `kg_documents` / `kg_hypotheses`). Consumes `knowledge_article_created` /
  `_revised` / `_archived`. On created/revised it reads the page title + the
  new revision's `fact:` citations from Postgres, then: MERGEs `(:WikiPage {slug})`
  (sets title/kind/article_id/revision/group_id/recorded_at, clears `archived`);
  `MATCH … MERGE`s `(:WikiPage)-[:SUMMARIZES]->(entity)` for entity-backed pages
  whose `entity_ref.label` maps to a KG node the system already creates
  (`Compound {inchikey}` / `NCEProject {internal_id}` / `Document {document_id}`
  — `MATCH` returns zero rows when the node is absent, so no stub is created);
  `MATCH … MERGE`s `(:WikiPage)-[:GROUNDS {fact_id: <uuidv5(slug,fact)>}]->(:Fact)`
  for each `fact:` citation that matches an existing `:Fact` (re-cite resurrects
  + restamps `cited_at_revision`), then closes any `:GROUNDS` edge with
  `cited_at_revision < new` (bi-temporal `invalidated_at`). On `_archived` it
  sets `wp.archived = true` and closes the page's live `:GROUNDS` edges. No
  Postgres read on the archive path. Idempotent (deterministic edge ids + MERGE;
  replay-safe via `projection_acks`).
* `knowledge_article_*` `consumed_by` already lists `wiki_kg` (`db/init/58`).
* `docker-compose.yml` (`wiki-kg`, `profiles: ["full"]`, `depends_on` postgres +
  neo4j, `NEO4J_*` env), `infra/helm/values.yaml` + `core-deployments.yaml`
  (`projectors.wikiKg`, default `enabled: true`), `Makefile` (`make run.wiki-kg`).
* pytest: `tests/unit/projectors/test_wiki_kg.py` — `:WikiPage` MERGE params,
  `:SUMMARIZES` Cypher for a mapped label (+ skip for an unmapped one),
  `:GROUNDS` per fact with deterministic edge id, dropped-facts close on a
  lower-revision regen, archive path (flag + close, no PG read), missing-slug /
  row-gone no-ops, `_deterministic_edge_id` determinism, `_safe_group_id` guard.
  `.venv/bin/pytest tests/unit/projectors/ -q` → 51 passed; ruff clean (mypy on
  `wiki_kg/main.py` clean — the `neo4j_client.py` arg-type noise only shows up
  with `neo4j` stubs installed locally, not in CI).
* **Done**: revising a page MERGEs the `:WikiPage` + `:GROUNDS` edges and closes
  the dropped ones; archiving closes them all.

### Phase 3b — `wiki_search_index` projector + `wiki_chunks` table  ✅ done

* `db/init/61_wiki_chunks.sql` — `wiki_chunks` table (sibling of
  `document_chunks`, NOT a `source_type` discriminator): `article_id` FK, `slug`,
  `revision`, `chunk_index`, `heading_path`, `text`, `embedding vector(1024)`,
  `token_count`; HNSW (cosine) + trigram indexes; RLS transitive through the
  parent article (FORCE-RLS'd); grants (`chemclaw_app` SELECT-only — the app
  never writes it; `chemclaw_service` ALL); `schema_version` row.
* `services/projectors/wiki_search_index/` (`main.py` + `__init__.py` +
  `requirements.txt` + `Dockerfile`) — `BaseProjector` consuming
  `knowledge_article_created`/`_revised`/`_archived`. On created/revised: reads
  the article's *current* slug/revision/body/status (so a replayed old event
  re-indexes the current page), `archived` status → DELETEs its chunks; else
  heading-aware-chunks the body (`_chunk_markdown` — ATX-heading stack,
  ~1.4 KB target, mid-section flush, no paragraph sub-split), embeds via
  `mcp-embedder` (`/tools/embed_text`, batched, BGE-M3), then in one transaction
  DELETEs the article's old `wiki_chunks` rows and INSERTs the fresh ones — so
  `wiki_chunks` always holds exactly the current revision's chunks. A stub
  (`body_md = ''`) → DELETE + 0 INSERT, no embed call. `_archived` → DELETE.
  Embedder 4xx → permanent skip (ack), leave old chunks (stale > empty); 5xx /
  network → propagate (retry). Idempotent; replay-safe.
* `knowledge_article_*` `consumed_by` already lists `wiki_search_index` (`db/init/58`).
* `docker-compose.yml` (`wiki-search-index`, `profiles: ["full"]`, `depends_on`
  postgres + mcp-embedder, `MCP_EMBEDDER_URL` env), `infra/helm/values.yaml` +
  `core-deployments.yaml` (`projectors.wikiSearchIndex`, default `enabled: true`),
  `Makefile` (`make run.wiki-search-index`).
* pytest: `tests/unit/projectors/test_wiki_search_index.py` — `_chunk_markdown`
  (heading-path tracking, mid-section flush, empty body), DELETE-then-INSERT per
  chunk with the right params + vector literal, stub → no-op-no-embed, archive
  event → DELETE, archived-status → DELETE, embedder 4xx → leave old chunks,
  missing row → no-op. `.venv/bin/pytest tests/unit/projectors/ -q` → 61 passed;
  ruff + mypy clean.
* **Done**: writing a page body re-chunks + re-embeds it into `wiki_chunks`
  (clearing the old chunks); archiving drops it from the index.

### Phase 3c — `search_knowledge` / `retrieve_related` wiki arm  ✅ done

* `core/types.ts` — added `"knowledge_article"` to the `Citation.source_kind`
  union (source_uri is the page slug).
* `search_knowledge` — new `include_wiki` input (default true). The
  `withUserContext` block now also runs dense + sparse arms over `wiki_chunks`
  (joined to `knowledge_articles` for slug/kind/title, `status='current'`,
  RLS transitively scoped): in `hybrid` mode all four arms RRF-fuse together
  (`chunk_id` is a UUID from disjoint tables — unambiguous key); in `dense` /
  `sparse` mode the doc + wiki rows are score-merged + re-sorted. Each hit now
  carries `kind: "document" | "wiki"`; wiki hits set `slug` / `article_id`,
  `document_id: null`, `source_type` = the article kind, `document_title` = the
  article title, and a `knowledge_article` citation. `KnowledgeHit` schema
  gained `kind` / `article_id` / `slug` (all required); `document_id` is now
  nullable.
* `retrieve_related` — passes `include_wiki: true` to `search_knowledge`, so
  wiki pages surface in its `kind:"chunk"` arm for free (a dedicated
  `kind:"wiki"` item is a BACKLOG follow-up).
* `query_provenance` — *not* changed this phase (the `:Fact → GROUNDS ←
  :WikiPage` walk needs an `mcp-kg` endpoint or a direct Neo4j query — BACKLOG).
* vitest: `tests/unit/builtins/search_knowledge.test.ts` gained "hybrid mode
  (default include_wiki) surfaces a knowledge-wiki page hit" (asserts the
  `kind:"wiki"` hit's slug/article_id/source_type/citation + that the
  `wiki_chunks` SQL ran) and "include_wiki=false skips the wiki_chunks arm"
  (asserts no `wiki_chunks` query). The existing dense/sparse tests are
  unchanged — the extra wiki arms get empty results from the mock pool, so
  their assertions still hold. `npm test --workspace services/agent-claw` →
  1497 passed | 12 skipped; `npx tsc --noEmit` ok; `npm run lint` ok.
* **Done**: `search_knowledge("…")` returns a `kind:"wiki"` hit among the
  results; `retrieve_related` surfaces it too.

### Phase 3c-followup — `query_provenance` ← `:WikiPage`

* Extend `query_provenance` (or add an `mcp-kg` endpoint) to walk
  `:Fact → GROUNDS ← :WikiPage`; optionally have `read_article` surface
  "referenced by N facts in the KG"; give `retrieve_related` a dedicated
  `kind:"wiki"` item.
* **Done when**: `query_provenance(fact_id)` lists the page that asserts it.

### Phase 4a — `wiki_linter` cron (deterministic sweep)  ✅ done

* `services/optimizer/wiki_linter/` (`main.py` + `__init__.py` +
  `requirements.txt` + `Dockerfile`; reuses the `services/optimizer/*` cron
  pattern, like `wiki_regen`) — every `WIKI_LINTER_POLL_HOURS` (default 6) it:
  (1) **missing-page** — creates a `dirty` stub `project/<internal_id>` page for
  any NCE project lacking one (`INSERT … ON CONFLICT (slug) DO NOTHING`,
  `dirty_reason='lint:missing_page'`; the `wiki_regen` daemon then fills it);
  (2) **orphan** — logs (warn) any agent-authored `topic/` page with no inbound
  `[article:…]` citation (not auto-fixed — needs human judgement);
  (3) **index rebuild** — regenerates the `index` page body: a Karpathy-style
  catalog grouped by kind (slug · title · maturity · #sources · last-updated ·
  `dirty?`/`human-edited?` flags), written only when it changed, never bumping
  `revision` (it's a derived catalog, not a versioned doc);
  (4) appends a one-line `## [date] lint | …` summary to the `log` page.
  Pure-Postgres, **no LLM** (matching the "plumbing is deterministic" rule); per
  sweep wrapped in try/except so one failure doesn't kill the loop; connects as
  `chemclaw_service`. Wired into `docker-compose.yml` (`wiki-linter`,
  `profiles: ["full"]`), `infra/helm` (`projectors.wikiLinter`), `Makefile`
  (`make run.wiki-linter`); `services/optimizer/wiki_linter/*` added to the
  coverage `omit` + `tests/unit/optimizer/test_wiki_linter.py` to the CI pytest
  list (same as `wiki_regen`).
* pytest: `tests/unit/optimizer/test_wiki_linter.py` — `_render_index`
  (kind grouping/order, `article:` links, flags, summary truncation),
  `_sweep_missing_project_pages` (creates dirty stubs / no-op), `_sweep_orphans`
  (returns unlinked topic pages), `_rebuild_index` (writes when changed / no-op
  when unchanged), `run_once` (stats + the `log` append). 7 passed; ruff + mypy
  clean.
* **Done**: a lint run creates a stub for a project that has no page yet,
  rebuilds the `index`, and logs an entry.

### Phase 4b — contradiction pages + admin route + `/wiki` verb + curator skill

* Extend `wiki_linter`: a stale-citation backstop sweep (needs a Neo4j
  connection to read `:Fact.invalidated_at`) and `contradiction/<slug>` page
  generation for entities with ≥N `expert_disputed`/`invalidated` facts (needs
  Neo4j + an LLM call via the new `wiki.contradiction` `prompt_registry` mode).
* `POST /api/admin/articles/:id/maturity` — `guardAdmin`, `appendAudit`,
  cache-bust; runbook `docs/runbooks/knowledge-wiki-curation.md`.
* `/wiki` slash verb (slash parser) + `skills/wiki-curator/SKILL.md` +
  `skill_library` seed row.
* **Done when**: a lint run spins up a `contradiction/` page; an admin can
  promote a page to FOUNDATION (audited); `/wiki <slug>` opens the curator skill.

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
