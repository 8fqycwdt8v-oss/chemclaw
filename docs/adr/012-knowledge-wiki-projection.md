# ADR 012 — Knowledge-wiki projection layer

Status: accepted (2026-05-12)

## Context

ChemClaw stores knowledge in three layers, all driven by the event-sourced
"A-on-C" spine (ADR 001):

  * **Canonical ledger** (Postgres) — `experiments`, `compounds`, `reactions`,
    `documents` / `document_chunks`, `hypotheses` / `hypothesis_citations`,
    `artifacts`, `skill_library` / `forged_tool_*`, `prompt_registry`,
    `research_reports`, `agent_sessions`, `feedback_events`, …
  * **Reasoning layer** (Neo4j via Graphiti-style projectors) — every fact is a
    bi-temporal edge with a UUIDv5 `fact_id`, a 5-bucket `ConfidenceTier`, a
    `confidence_score`, a mandatory `Provenance` blob, and a `group_id` for RLS
    parity. Node types: `:Compound`, `:Reaction`, `:Experiment`,
    `:SyntheticStep`, `:NCEProject`, `:Hypothesis`, `:Document` / `:Chunk`,
    `:CalculationResult` / `:Conformer`, `:SourceEntity` / `:LiteralFact`.
  * **Semantic index** (pgvector / pgvectorscale on the app Postgres) —
    `document_chunks.embedding` (BGE-M3, HNSW, hybrid dense+sparse RRF in
    `search_knowledge`); a separate halfvec collection for reaction DRFP
    similarity.

What is **missing** is a human-readable, navigable, *maintained* surface over
all of that:

  1. **Knowledge is shredded, never synthesized in prose.** Everything the
     agent knows about a compound is scattered across `:Compound` edges,
     `document_chunks`, `reactions`, `hypotheses`, `artifacts`, and QM results.
     There is no single artifact a chemist (or the agent) can *read*.
  2. **Synthesis is re-derived every query.** Answering "what do we know about
     the Buchwald–Hartwig step in project NCE-0042" runs N retrievals and
     re-pieces the same fragments each time. The synthesis evaporates into chat
     history (`research_reports` is the closest persisted form — but it is
     write-once, per-user, unlinked, and never updated when the underlying
     facts change).
  3. **The only curation primitive is the maturity tier** (EXPLORATORY →
     WORKING → FOUNDATION) — an attribute on rows, not a document a human can
     edit. There is no place for a chemist to write "the literature claim of
     92 % yield does not reproduce above 5 mmol scale" and have the agent
     respect it.
  4. **No cheap of cross-references / contradiction pages.** Contradictions
     surface only as `expert_disputed` / `invalidated` edges; nothing rolls
     them up into a page that says "claims about X disagree, here's the map".

This is the gap the 2026 "LLM wiki" pattern (Karpathy; "LLM Wiki v2"),
GraphRAG's entity / community summary pages, and the "markdown vault for
canonical knowledge + graph/vector for retrieval" consensus all address. The
key reframing: **a wiki and the KG are not either/or — they are dual
representations.** The KG is the *atom store* (machine-queryable, time-sliceable,
contradiction-aware, provenance on every edge); the wiki is the *molecule
layer* (human-readable, navigable, synthesized). ChemClaw is unusually
well-positioned for this because it already has a real graph *and* an event log
to drive the projection.

Options considered (full write-up in `docs/plans/knowledge-wiki-projection.md`):

  * **A — wiki as a first-class projection layer** *(chosen)*: new canonical
    `knowledge_articles` table, event-sourced like everything else; a
    `wiki_pages` projector that (re)generates entity / synthesis pages from KG /
    document / hypothesis / artifact events; pages indexed into the same vector
    space and mirrored as `:WikiPage` nodes in Neo4j; human edits flow back as
    an `expert_validated` source; a nightly `wiki_linter` cron for staleness /
    contradictions.
  * **B — markdown-first, KG demoted to a derived index**: rejected. Loses
    bi-temporal rigor, deterministic projector replay, and the per-row RLS
    story; the whole architecture is built around A-on-C. The KG is not the
    problem; the missing wiki layer is.
  * **C — adopt an off-the-shelf wiki engine** (Semantic MediaWiki / Wikibase /
    Outline): rejected. Another service to operate; SMW is GPL (we already
    carry the Neo4j GPL constraint); the tenant/RLS model does not map;
    permanent sync tax. Reimplementing the ~20 % of SMW we need (Option A) is
    cleaner than integrating 100 % of it.
  * **D — git-backed markdown vault** (the literal Karpathy setup): rejected.
    A git repo is one tenant; no transactional consistency with the event log;
    the agent runs in ephemeral containers without a persistent checkout;
    audit/observability regresses versus Postgres.

## Decision

Add a **knowledge-wiki projection layer**: a set of canonical
`knowledge_articles` + `knowledge_article_revisions` + `knowledge_article_citations`
tables, event-sourced and RLS-scoped exactly like the rest of the ledger; a
`wiki_pages` projector that materialises entity and synthesis pages from the
event stream; a `wiki_kg` projector that mirrors pages as `:WikiPage` nodes with
`:SUMMARIZES` / `:GROUNDS` edges back to facts; a `wiki_search_index` projector
that chunks + embeds article bodies into the existing pgvector space (so
`search_knowledge` returns pages, not just raw chunks); a nightly `wiki_linter`
cron; a small set of agent builtins (`read_article`, `list_articles`,
`upsert_article`, `request_article`, plus article hits folded into
`search_knowledge` / `retrieve_related`); an admin route for maturity promotion;
a `/wiki` slash verb and a `wiki_curator` skill. The whole feature is gated by
the `wiki.enabled` feature flag and tuned via `config_settings`.

### The reframing in one line

> The wiki is the human-readable face of the bi-temporal KG. The agent reads a
> page instead of re-deriving the synthesis; humans edit a page and the edit
> becomes an authoritative source the projector must respect; a linter keeps
> the page honest about staleness and contradictions.

### Data model (`db/init/58_knowledge_wiki.sql`)

**`knowledge_articles`** — the current ("head") version of each page.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text UNIQUE | stable key — e.g. `compound/<inchikey>`, `reaction-family/<rxno>`, `project/<internal_id>`, `campaign/<uuid>`, `document/<sha256-prefix>`, `topic/<slug>`, `glossary`, `index`, `log`, `contradiction/<slug>` |
| `kind` | text | `compound \| reaction_family \| nce_project \| synthesis_campaign \| document_digest \| researcher \| topic \| glossary \| index \| log \| contradiction` |
| `title` | text | |
| `summary` | text | one-line; used in `index` |
| `body_md` | text | the markdown body; inline citations as `[fact:UUID]` / `[chunk:ID]` / `[experiment:ID]` / `[article:slug]` |
| `entity_ref` | jsonb | `{label, id_property, id_value}` for entity-backed pages (links to a KG node); null for synthesis pages |
| `nce_project_id` | uuid NULL → `nce_projects` | set ⇒ project-scoped (RLS via `user_project_access`); null ⇒ org-wide (authenticated-session gate, like `compounds` / `documents`) |
| `group_id` | text DEFAULT `'__system__'` | Neo4j RLS parity for the `:WikiPage` projection (mirrors KG edges) |
| `maturity` | text DEFAULT `'EXPLORATORY'` CHECK ∈ `('EXPLORATORY','WORKING','FOUNDATION')` | reuses the existing convention |
| `confidence_score` | numeric(4,3) NULL | derived aggregate over cited facts; null = not yet computed |
| `status` | text DEFAULT `'current'` CHECK ∈ `('current','archived')` | archived = entity retired; row + revisions retained |
| `dirty` | boolean DEFAULT true | a backing event has arrived (or the page is brand-new) and the page needs (re)synthesis; the projector / linter picks dirty pages up |
| `dirty_reason` | text | last event type / `'manual:created'` / `'human_edit'` / `'lint:stale_citation'` … |
| `has_human_edits` | boolean DEFAULT false | once true, regeneration treats human-owned blocks as sacrosanct (block markers in `body_md`) |
| `source_count` | int DEFAULT 0 | distinct sources contributing (à la Karpathy's index) |
| `revision` | int DEFAULT 1 CHECK > 0 | bumps on every body change |
| `etag` | bigint DEFAULT 1 CHECK > 0 | optimistic concurrency (matches `synthesis_campaigns`) |
| `created_by` | text | entra id, or `'__system__'` for projector-generated |
| `last_edited_by` | text | entra id, or `'__projector__'` / `'__linter__'` |
| `created_at` / `updated_at` | timestamptz | `set_updated_at` trigger |
| `valid_from` / `superseded_at` | timestamptz | bi-temporal, matches `artifacts`; `superseded_at` set on archive |

**`knowledge_article_revisions`** — append-only history (one row per body
change). `(article_id, revision)` UNIQUE; `author_kind ∈ ('agent','human','projector','linter')`;
`author_entra_id` (null for non-human); `agent_session_id` → `agent_sessions`;
`change_note` terse; full `title` / `summary` / `body_md` snapshot.

**`knowledge_article_citations`** — what each *revision* cites (the provenance
backbone, and the key to staleness linting). `(article_id, revision, cite_kind,
cite_ref)` UNIQUE; `cite_kind ∈ ('fact','chunk','experiment','reaction','hypothesis','artifact','document','article')`;
`cite_ref` text (the id); `anchor` text NULL (section); `note` text NULL. Index
on `(cite_kind, cite_ref)` for the reverse lookup "which pages cite this fact?"
— so a `fact_invalidated` event can mark every citing page `dirty`.

**Triggers / events.** `set_updated_at` on `knowledge_articles`. An
`emit_knowledge_article_event()` trigger emits `ingestion_events`:
`knowledge_article_created` (INSERT), `knowledge_article_revised` (UPDATE where
`revision` changed), `knowledge_article_archived` (UPDATE where `status` →
`'archived'`). Payload carries `{article_id, slug, kind, revision, nce_project_id,
last_edited_by, has_human_edits}`. Catalog rows added to `ingestion_event_catalog`.

**RLS.** `knowledge_articles`: `FOR ALL` policy — org-wide rows
(`nce_project_id IS NULL`) require a non-empty `app.current_user_entra_id`
(matches `documents` / `compounds`); project-scoped rows use the
`EXISTS user_project_access` pattern (matches `synthesis_campaigns`).
`knowledge_article_revisions` / `knowledge_article_citations`: scoped via the
parent article (EXISTS join). Projectors connect as `chemclaw_service`
(BYPASSRLS). `chemclaw_app` gets SELECT / INSERT / UPDATE on articles, SELECT /
INSERT on revisions + citations. Every project-scoped table gets
`FORCE ROW LEVEL SECURITY`.

### Page taxonomy (v1)

Auto-generated (by the `wiki_pages` projector, from events):

  * **`compound/<inchikey>`** — identity, structure, where it appears
    (reactions / experiments / projects), QM results, hypotheses, similar
    compounds. Org-wide (like `compounds`).
  * **`reaction-family/<rxno>`** — RXNO class digest: representative reactions,
    condition trends, applicability-domain notes, similar-reaction clusters.
    Org-wide.
  * **`project/<internal_id>`** — NCE project digest: synthetic route, steps,
    experiments, campaigns, open hypotheses, key documents. Project-scoped.
  * **`campaign/<uuid>`** — synthesis-campaign digest (DAG state, outcomes).
    Project-scoped.
  * **`document/<sha256-prefix>`** — per-document summary + key extractions +
    "cited by" backlinks. Org-wide (matches `documents`).

Synthesis pages (maintained by the `wiki_pages` / `wiki_linter` pair):

  * **`index`** — the content catalog: every current page, one-line summary,
    `kind`, `source_count`, `maturity`, last-updated. The agent reads this
    first when navigating (Karpathy's `index.md`).
  * **`log`** — append-only chronological record of ingest / regen / lint /
    human-edit events (`## [2026-05-12] regen | compound/RYYVLZ… | after fact_invalidated`).
  * **`glossary`** — domain terms / abbreviations / internal codes (masked) →
    short definitions, cross-linked.
  * **`contradiction/<slug>`** — auto-spun when `expert_disputed` /
    `invalidated` edges accumulate on an entity; lays out the conflicting
    claims, their provenance, and the current resolution (if any).
  * **`topic/<slug>`** — agent- or human-created concept pages that don't map
    1:1 to a KG node (e.g. `topic/buchwald-hartwig-amination`,
    `topic/genotoxic-impurity-control`). The only page kind a human typically
    *creates from scratch*; the rest they *edit*.

### Regeneration model

Not "full regen on every event" (too expensive) and not "regenerate only when
asked" (drifts). The model is **mark-dirty + debounced batch + on-read**:

  1. A backing event arrives (`kg_*` fact write, `document_ingested`,
     `hypothesis_*`, `fact_invalidated`, `synthesis_campaign_*`, …). The
     `wiki_pages` projector resolves the affected page slug(s) (via
     `entity_ref` and the citation reverse-index) and sets `dirty = true`,
     `dirty_reason = <event_type>`. New entities create a stub page (`dirty`,
     `body_md` = a deterministic template) so there is always *something* to
     read.
  2. A debounced batch (config: `wiki.regen_debounce_seconds`, default 300;
     `wiki.regen_max_per_hour`, default 200; `wiki.regen_model`, default a
     Haiku-class model via central LiteLLM) regenerates dirty pages: it pulls
     the entity's current KG facts + relevant chunks + hypotheses + artifacts,
     re-synthesises the body with inline `[fact:…]` citations, preserves
     human-owned blocks verbatim, writes a new revision + a fresh citation set,
     recomputes `confidence_score` as the (recency- and tier-weighted) mean of
     cited facts, clears `dirty`, appends a `log` entry.
  3. If the agent opens a `dirty` page via `read_article` and
     `wiki.regen_on_read` is set, it triggers a synchronous single-page regen
     before returning (bounded by `wiki.regen_on_read_timeout_ms`); otherwise
     it returns the stale body with a `stale: true` banner and the dirty reason.

All regeneration goes through central LiteLLM (single egress chokepoint, full
redaction) using a `wiki.synthesis` prompt-registry mode — not a hardcoded
string.

### Human edits

`PATCH /api/articles/:id` (RLS-scoped) replaces the body, sets
`has_human_edits = true`, bumps `revision` + `etag`, writes a
`knowledge_article_revisions` row with `author_kind = 'human'`, and emits
`knowledge_article_revised`. The body convention: a human wraps authoritative
prose in a fenced block

```
<!-- human:begin owner=<entra-id> -->
…authoritative prose…
<!-- human:end -->
```

The `wiki_pages` regenerator copies `human:*` blocks through verbatim and may
add `<!-- agent:note -->` annotations *around* them, never inside. A
`wiki_kg` projection writes the human-owned claims as `expert_validated` facts
(so the rest of the system — `check_contradictions`, the confidence ensemble —
treats them with the right authority). The agent's `upsert_article` builtin
*cannot* write inside a `human:*` block (a `pre_tool` hook rejects it).

### KG integration (`wiki_kg` projector)

On `knowledge_article_created` / `_revised`: MERGE a `:WikiPage` node
(`slug` identity, deterministic UUIDv5 `fact_id`, `group_id`); for entity-backed
pages, `(:WikiPage)-[:SUMMARIZES]->(<entity node>)`; for each citation in the
new revision, `(:WikiPage)-[:GROUNDS]->(:Fact {fact_id})` (closes the prior
`:GROUNDS` edges that the new revision dropped — bi-temporal `invalidated_at`,
idempotent `CASE WHEN` guards, à la `kg_hypotheses`). On
`knowledge_article_archived`: close the `:WikiPage`'s outgoing edges. This
makes `query_provenance` walk `:Fact → GROUNDS ← :WikiPage` so "which page
asserts this" is answerable, and `retrieve_related` can fan out from an entity
to its page.

### Search integration (`wiki_search_index` projector)

On `knowledge_article_revised`: re-chunk the body (heading-aware, same chunker
as `doc_ingester`), embed via `mcp-embedder`, upsert into `document_chunks`
(or a sibling `wiki_chunks` table — TBD in Phase 3; sibling table preferred so
`source_type` filters stay clean) tagged `source_type = 'wiki'` with a back-link
to `article_id` + `slug`. So `search_knowledge` / `retrieve_related` surface
*pages* alongside raw doc chunks, and the agent prefers reading the synthesised
page (Karpathy's token-efficiency win). Stale chunks for superseded revisions
are deleted in the same transaction.

### Linting (`wiki_linter` cron, reuses the `services/optimizer/*` pattern)

Nightly: (1) **stale-citation** — for every current page, check each cited
`fact:` against the KG; if invalidated, mark the page `dirty`
(`lint:stale_citation`) and note it on the `log`. (2) **orphan** — pages with
no inbound `[article:…]` links and no `entity_ref` (other than `index` / `log` /
`glossary`) get flagged on the `log` for human review. (3) **missing-page** —
high-degree KG entities (compounds in ≥ N reactions, projects with ≥ N steps)
with no `compound/` / `project/` page get a stub created. (4)
**contradiction-page** — entities with ≥ N `expert_disputed` / `invalidated`
edges get a `contradiction/<slug>` page created or refreshed. (5)
**index/log integrity** — rebuild `index` from `knowledge_articles`; verify
`log` is append-only and parseable. Everything the linter does is logged on the
`log` page and via the structured logger.

### Agent surface

  * **`read_article(slug | id, [revision])`** — returns title, body_md,
    summary, maturity, confidence_score, citations[], `stale` flag + reason,
    `has_human_edits`. Triggers on-read regen if configured.
  * **`list_articles({kind?, project?, query?, maturity_min?, dirty_only?, limit})`**
    — lists the `index` (or a filtered slice). Cheap navigation.
  * **`upsert_article({slug, kind, title, summary, body_md, entity_ref?, project?})`**
    — agent authors / overwrites a page (typically a `topic/` page or a
    synthesised answer it wants to keep — the Karpathy "file the answer back
    into the wiki" move). Rejected by a `pre_tool` hook if it would write
    inside a `human:*` block or set `maturity` above EXPLORATORY.
  * **`request_article({slug, kind, entity_ref?, reason})`** — flags a page as
    wanted (creates a `dirty` stub); the projector / linter fills it. Use when
    the agent notices a gap mid-task.
  * **`search_knowledge` / `retrieve_related`** — extended to include `wiki`
    source hits, ranked in the same RRF.
  * **`/wiki <query|slug>`** slash verb — activates the `wiki_curator` skill
    (knows the page taxonomy, the human-block convention, when to `upsert` vs
    `request`).
  * **`POST /api/admin/articles/:id/maturity`** — admin-gated (`guardAdmin`),
    audited (`appendAudit`), promotes EXPLORATORY → WORKING → FOUNDATION;
    busts the relevant caches.

### Config / flags / hooks

  * Feature flag `wiki.enabled` (env fallback `WIKI_ENABLED`) — gates the
    projectors, the cron, the builtins (the builtins are registered always but
    short-circuit when disabled).
  * `config_settings`: `wiki.regen_model`, `wiki.regen_debounce_seconds`
    (300), `wiki.regen_max_per_hour` (200), `wiki.regen_on_read` (true),
    `wiki.regen_on_read_timeout_ms` (8000), `wiki.linter.min_degree_for_page`
    (3), `wiki.linter.min_disputed_for_contradiction_page` (2),
    `wiki.confidence.recency_halflife_days` (180).
  * Prompt-registry mode `wiki.synthesis` (page (re)generation),
    `wiki.contradiction` (contradiction-page synthesis) — seeded in
    `db/seed/02_prompt_registry.sql`.
  * New `pre_tool` hook `wiki-human-block-guard` — rejects `upsert_article`
    writes that touch a `human:*` block or over-promote maturity. Counts toward
    `MIN_EXPECTED_HOOKS`.
  * New projectors: `wiki_pages`, `wiki_kg`, `wiki_search_index` (Python,
    `BaseProjector` subclasses, in `services/projectors/wiki_*`); wired into
    `docker-compose.yml` + `infra/helm/`. `wiki_kg` uses
    `services/projectors/common/neo4j_client.py` (direct-driver, like
    `kg_hypotheses` — `:WikiPage` is not a `:Fact`).
  * New cron: `services/optimizer/wiki_linter/`.

## Consequences

**Positive.**

  * A chemist (and the agent) can finally *read* what the system knows about a
    compound / project / reaction family, with every claim citation-traced.
  * Synthesis compounds instead of being re-derived: the agent reads one page
    rather than running N retrievals + re-piecing fragments — the Karpathy
    token-efficiency / quality win, with provenance kept.
  * Contradictions get a home (`contradiction/` pages) instead of being
    invisible `expert_disputed` edges.
  * Human edits become a first-class, authoritative input that the rest of the
    system (confidence ensemble, `check_contradictions`) already understands —
    no new authority concept, just `expert_validated` facts plus a sacrosanct
    block convention.
  * Zero churn on the load-bearing KG / event spine: the wiki is *another*
    derived view obeying the same "never update a derived view without an
    event; projectors are replayable" rules. Full rebuild =
    `DELETE FROM projection_acks WHERE projector_name IN ('wiki_pages','wiki_kg','wiki_search_index')`
    and re-derive.

**Negative / risks.**

  * **LLM cost.** Page regeneration is LLM work. Mitigated by mark-dirty +
    debounce + per-hour cap + a cheap model + on-read laziness, all in
    `config_settings`, plus the `wiki.enabled` kill switch. Worst case the
    feature is disabled and the rest of the system is unaffected.
  * **Stale pages.** A page can lag its backing facts between regens. Mitigated
    by the `stale` banner + dirty reason on every read, the stale-citation
    linter, and on-read regen for the page the agent is actually looking at.
  * **Human/agent edit conflicts.** Mitigated by the `human:*` block
    convention + the `wiki-human-block-guard` pre_tool hook + revision history;
    worst case a human reverts via the revisions table.
  * **Vector-index bloat.** Indexing article bodies grows `document_chunks` (or
    `wiki_chunks`). Mitigated by deleting superseded-revision chunks in the
    same transaction and a sibling table so doc-only searches stay clean.
  * **Scope creep.** The taxonomy could metastasise. Mitigated by shipping the
    v1 page kinds only and requiring an ADR amendment for new auto-generated
    kinds (human-authored `topic/` pages are unconstrained).

**Phasing.** Implementation is staged — see
`docs/plans/knowledge-wiki-projection.md`. Phase 0 (this change) lands the ADR,
the plan, and `db/init/58_knowledge_wiki.sql` (the data model, RLS, triggers,
event-catalog rows). Phases 1–5 land the read/write builtins, the `wiki_pages`
projector, the `wiki_kg` + `wiki_search_index` projectors, the `wiki_linter`
cron + admin route + slash verb + skill, and the feature-flag / config / prompt
wiring respectively. Each phase is its own reviewed PR.

## Related

  * ADR 001 (architecture / A-on-C / bi-temporal KG), ADR 004 (harness), ADR
    005 (data-layer revision), ADR 007 (hook system), ADR 011 (synthesis
    campaigns — same "umbrella table + steps + events + builtins" shape).
  * `docs/plans/knowledge-wiki-projection.md` — phased implementation plan and
    the full options analysis.
  * External: Karpathy "llm-wiki" (gist 442a6bf…, April 2026); "LLM Wiki v2"
    (gist 2067ab41…); Microsoft GraphRAG (entity / community summary pages);
    "Implementation of an open chemistry knowledge base with a Semantic Wiki",
    *J. Cheminformatics* 17, 2025 (the Wikibase-vs-SMW evaluation we explicitly
    chose not to follow).
