# Universal Knowledge Accumulation — Design Spec

**Status:** Draft (brainstormed 2026-05-14; awaiting user review before plan / implementation).
**Owner:** ChemClaw core.
**Companion ADR (to be written after spec approval):** `013-universal-knowledge-accumulation.md`.

## 1. Summary

ChemClaw today is an *occasional* knowledge accumulator: a handful of sources
emit ingestion events, six projectors materialise derived views, and most
in-silico calculations / analytical runs / document semantics never reach
the KG or the wiki at all. The agent's `source-cache` hook makes things
*reactive* — knowledge accumulates only when the agent happens to query
a source-system tool.

This spec turns ChemClaw into a **continuous, autonomous knowledge
accumulator**. Every datum the system touches — every MCP tool result,
every analytical dataset, every ELN row, every document, every workflow
run, every agent conclusion — is automatically extracted into structured
facts, optionally interpreted by an LLM, scored for investigation
priority, and propagated through the KG and the wiki. When the
extraction surfaces gaps, the system proactively schedules calculations
or experiments to fill them. When it finds anomalies or patterns, it
forms hypotheses and designs tests to discriminate them. The chemist
loop runs unattended.

The constitutional principle: **all sources, always, automatically.
Volume and cost are controlled by capability gates and budgets, never
by exclusion.**

## 2. Problem statement

### 2.1 Where knowledge currently does and does not accumulate

| Source family                                 | Today                                                                  |
|-----------------------------------------------|------------------------------------------------------------------------|
| Document text                                 | Chunked + embedded; **no structured facts extracted**                  |
| ELN canonical (`mock_eln.*`)                  | Only via reactive `source-cache` hook when agent queries               |
| Analytical (`fake_logs.*` HPLC / NMR / MS)    | Same — reactive only                                                   |
| QM / DFT / xTB                                | → `qm_kg` projector ✓                                                  |
| Compound fingerprints / class                 | Deterministic projectors ✓                                             |
| Hypotheses (agent-authored)                   | → `kg_hypotheses` ✓                                                    |
| Workflow runs                                 | On success only → `kg_experiments` ✓                                   |
| Chemistry MCPs (aizynth, askcos, chemprop,    | **None** — ephemeral tool outputs, nothing persisted as facts          |
| genchem, synthegy, applicability, plate,      |                                                                        |
| yield_baseline, sirius, crest, tabicl,        |                                                                        |
| ord_io, chrom_method_optimizer,               |                                                                        |
| reaction_optimizer)                           |                                                                        |
| Optimization campaigns / Pareto fronts        | None                                                                   |
| Synthesis-campaign events                     | None — DAG state only                                                  |
| Failed / negative results                     | Logged as telemetry, discarded                                         |
| Agent reasoning conclusions                   | None unless explicit `propose_hypothesis`                              |
| External public data                          | None                                                                   |
| Forged-tool validation runs                   | None                                                                   |

### 2.2 What "behave like a chemist" requires the system to do

A working chemist:

1. Records every observation, including failures.
2. Asks "does this fit what I expected?" of every new datum (anomaly check).
3. Looks for patterns across observations within a project, then across projects.
4. Cross-references literature on every nontrivial result.
5. Forms hypotheses from clusters of anomalies / patterns.
6. Designs experiments or calculations that would discriminate competing
   hypotheses.
7. Updates the lab notebook (the wiki) so that future-self and colleagues
   can pick up the thread.

ChemClaw can do (5) and (7) today; everything else is on the agent's
shoulders or doesn't happen at all. This design closes that gap by making
1–6 background processes that run on every datum and every cycle.

## 3. Design overview

### 3.1 The loop

```
                                  ┌──────────────────────────────────────┐
                                  │  Source emission                     │
                                  │  (MCP tool, ELN row, doc, workflow,  │
                                  │   external feed, agent conclusion)   │
                                  └─────────────┬────────────────────────┘
                                                │
                                                ▼  emits ingestion event
                ┌──────────────────────────────────────────────────────────┐
                │  (1) EXTRACTION       deterministic per source            │
                │      typed MCP output → `extracted_fact` events           │
                │      doc chunks       → `extracted_fact` events (LLM)     │
                │      derivation_class = OBSERVED | COMPUTED               │
                └──────────────────────────┬───────────────────────────────┘
                                           │
                                           ▼
                ┌──────────────────────────────────────────────────────────┐
                │  (2) INVESTIGATION SCORER                                 │
                │      novelty + anomaly magnitude + project priority +     │
                │      budget remaining → score ∈ [0,1]                     │
                │      score ≥ threshold_sync  → sync interpret             │
                │      score <  threshold_sync → queue for periodic sweep   │
                └──────────────────────────┬───────────────────────────────┘
                                           │
                ┌──────────────────────────┼──────────────────────────────┐
                ▼                          ▼                              ▼
        ┌────────────────┐      ┌────────────────────┐         ┌──────────────────┐
        │ (3) ANOMALY    │      │ (4) INTERPRETER     │         │ (5) PATTERN      │
        │  detect vs.    │      │  LLM reads fact +   │         │  periodic sweep   │
        │  KG-expected   │      │  KG context, emits  │         │  clusters facts;  │
        │  range; emit   │      │  derivation_class = │         │  emits derivation │
        │  anomaly_      │      │  INTERPRETED        │         │  _class =         │
        │  observed      │      │  facts              │         │  ABSTRACTED facts │
        └───────┬────────┘      └─────────┬───────────┘         └────────┬─────────┘
                │                          │                              │
                └──────────────┬───────────┴──────────────────┬───────────┘
                               ▼                              │
                ┌──────────────────────────────────┐          │
                │ (6) HYPOTHESIS FORMER            │          │
                │  LLM proposes hypothesis from    │          │
                │  anomalies / patterns /          │          │
                │  interpretations.                │          │
                │  derivation_class = HYPOTHESIZED │          │
                │  Bounded by project active-cap.  │          │
                └────────┬─────────────────────────┘          │
                         │                                    │
                         ▼                                    │
                ┌──────────────────────────────────┐          │
                │ (7) TEST PLANNER                 │          │
                │  For each active hypothesis,     │          │
                │  pick discriminating tests       │          │
                │  (xtb, dft, experiment, ELN q,   │          │
                │  literature search). Enqueue     │          │
                │  via workflow_engine /           │          │
                │  task_queue.                     │          │
                │  Bounded by compute budget.      │          │
                └────────┬─────────────────────────┘          │
                         │                                    │
                         └────────┐                           │
                                  ▼                           ▼
                          (test runs → new source emission → loop closes)

         All facts flow into Neo4j (:Fact nodes) and feed:
           ┌────────────────────────────────────────────┐
           │ (8) WIKI REGEN  (already exists)            │
           │  Dirty entity pages → LLM synthesises page  │
           │  with citations; human blocks preserved.    │
           └────────────────────────────────────────────┘
```

### 3.2 The two-axis confidence model (locked)

Every fact carries two independent fields:

- **`derivation_class`** (enum, governs capability):

  | Class           | Source                                              | Can spawn hypothesis? | Can trigger compute? | Can author wiki section? |
  |-----------------|-----------------------------------------------------|-----------------------|----------------------|--------------------------|
  | `OBSERVED`      | Measurement, instrument, ELN, source-cache hook     | yes                   | yes                  | yes                      |
  | `COMPUTED`      | Deterministic extractor over typed MCP output       | yes                   | yes                  | yes                      |
  | `INTERPRETED`   | LLM over structured data, schema-constrained        | yes                   | yes (≤ depth 2)      | yes                      |
  | `HYPOTHESIZED`  | LLM-proposed claim, awaiting test                   | **no**                | yes (test design)    | as `pending:` note only  |
  | `ABSTRACTED`    | Pattern over many facts                             | yes                   | no                   | yes (pattern section)    |

  Class can only travel **downward** through derivation: an `INTERPRETED`
  fact cannot derive an `OBSERVED` fact, and so on. When an
  `OBSERVED` measurement later confirms a `HYPOTHESIZED` claim, a *new*
  `OBSERVED` fact is emitted and the old hypothesis is marked
  `confirmed_by = <new_fact_id>`. Bi-temporal honesty is preserved.

- **`confidence`** (`NUMERIC(4,3)` 0–1, used only for ranking):

  ```
  fact.confidence = min(source_fact.confidence for source_fact in sources)
                    × extractor_reliability_factor[derivation_class]
  ```

  Reliability factors live in `config_settings`:

  ```
  kg.extractor_reliability.observed     = N/A   (use 4-signal ensemble)
  kg.extractor_reliability.computed     = 0.95  (typed Pydantic, deterministic)
  kg.extractor_reliability.interpreted  = 0.75  (LLM, schema-bound output)
  kg.extractor_reliability.hypothesized = 0.60  (LLM proposing claim)
  kg.extractor_reliability.abstracted   = 0.50  (cluster summary)
  ```

  Confidence cannot rise across derivations. Combined with downward-only
  class transitions, depth-runaway is mathematically impossible: a
  derivation chain of length 5 starting from a confidence-0.9 measurement
  bottoms out at `0.9 × 0.75 × 0.75 × 0.75 × 0.6 × 0.5 ≈ 0.114`, well
  below any threshold for further action.

### 3.3 Constitutional invariants

1. **All sources, always, automatically.** No source family is excluded.
   Volume and cost are controlled at the *consumption* side via class
   gates and budgets, never by refusing to record.
2. **Provenance is mandatory.** Every fact carries `source_fact_ids[]`
   (for derivations) and `source_table` / `source_row_id`
   (for extractions). No fact without a traceable origin.
3. **Bi-temporal honesty.** Derived facts get new IDs and new
   `valid_from`; they never overwrite older facts. Invalidation cascades
   via `fact_invalidated` events.
4. **Confidence is non-monotonic upward.** Confirmation creates a new
   `OBSERVED` fact; it never upgrades a `HYPOTHESIZED` one.
5. **Capability is class-bound.** A fact can only do what its class
   permits (see table above), regardless of confidence.
6. **Budgets bind every LLM and compute action.** The system never
   spawns a calc, a chunked LLM call, or an experiment without checking
   the relevant `config_settings` budget.
7. **Replayability.** Every projector is idempotent and a full rebuild is
   `DELETE FROM projection_acks WHERE projector_name = X` and let the
   event log re-derive everything. This applies to all new projectors
   in this design.

## 4. Architecture

### 4.1 Data model

#### 4.1.1 New columns on existing tables

```sql
-- Common derivation metadata, additive to existing fact-bearing tables.
-- These already carry confidence_score / confidence_tier from PR-8.

ALTER TABLE reactions          ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE hypotheses         ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE artifacts          ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE compute_results    ADD COLUMN IF NOT EXISTS derivation_class TEXT;
-- (etc. for any project-scoped fact-bearing table)

ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES facts(id);

-- Check constraints (deferrable; only on new rows):
ALTER TABLE reactions
  ADD CONSTRAINT reactions_derivation_class_chk
    CHECK (derivation_class IS NULL OR derivation_class IN
           ('OBSERVED','COMPUTED','INTERPRETED','HYPOTHESIZED','ABSTRACTED'))
    NOT VALID;
```

#### 4.1.2 New `facts` table (postgres-side mirror of `:Fact` nodes)

The Neo4j KG already stores `:Fact` nodes via `mcp-kg` and the direct-
driver projectors. We add a Postgres-side `facts` table as the
**canonical, RLS-enforced** projection target. Neo4j becomes the
query view; Postgres is the source of truth and the audit surface.

```sql
CREATE TABLE facts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID,                                 -- NULL → global / shared
  subject_label     TEXT NOT NULL,                         -- e.g. 'Compound'
  subject_id_value  TEXT NOT NULL,                         -- e.g. inchikey
  predicate         TEXT NOT NULL,                         -- e.g. 'has_barrier_kJ_mol'
  object_label      TEXT,                                  -- nullable for scalar objects
  object_id_value   TEXT,
  object_value      JSONB,                                 -- scalar / structured value
  unit              TEXT,                                  -- e.g. 'kJ/mol', '%'
  polarity          TEXT NOT NULL DEFAULT 'positive'
                    CHECK (polarity IN ('positive','negative','anomaly')),
  derivation_class  TEXT NOT NULL
                    CHECK (derivation_class IN
                           ('OBSERVED','COMPUTED','INTERPRETED','HYPOTHESIZED','ABSTRACTED')),
  confidence        NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  confidence_tier   TEXT NOT NULL,                         -- foundational / high / medium / low / exploratory
  source_table      TEXT,                                  -- canonical source row, if any
  source_row_id     TEXT,
  source_fact_ids   UUID[] NOT NULL DEFAULT ARRAY[]::UUID[], -- empty for OBSERVED/COMPUTED
  extractor_name    TEXT NOT NULL,                         -- projector / hook that emitted
  derivation_depth  INT  NOT NULL DEFAULT 0,
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to          TIMESTAMPTZ,
  invalidated_by    UUID REFERENCES facts(id),
  invalidation_reason TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Group_id mirrors Neo4j's project group; '__system__' for global facts.
  group_id          TEXT NOT NULL DEFAULT '__system__'
);

CREATE INDEX idx_facts_subject ON facts (subject_label, subject_id_value)
  WHERE valid_to IS NULL;
CREATE INDEX idx_facts_predicate ON facts (predicate)
  WHERE valid_to IS NULL;
CREATE INDEX idx_facts_class_polarity ON facts (derivation_class, polarity)
  WHERE valid_to IS NULL;
CREATE INDEX idx_facts_project ON facts (project_id) WHERE valid_to IS NULL;
CREATE INDEX idx_facts_source ON facts (source_table, source_row_id);

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE  ROW LEVEL SECURITY;

CREATE POLICY facts_project_visibility ON facts
  FOR SELECT
  USING (
    project_id IS NULL  -- global facts visible to all authenticated users
    OR current_user_has_project_access(project_id)
  );
-- INSERT/UPDATE/DELETE only via chemclaw_service (BYPASSRLS); user
-- writes go through admin endpoints, not direct.
```

A Neo4j sync projector (`kg_facts_sync`) mirrors `facts` rows to
`:Fact` nodes with deterministic ids (`fact_id_postgres = fact.id`), so
the KG and Postgres never diverge. Existing direct-driver projectors
(`kg_hypotheses`, `kg_documents`, `qm_kg`, `wiki_kg`) keep writing —
they just now also write the corresponding `facts` row first via the
same transaction.

#### 4.1.3 New ingestion event types

Added to `ingestion_event_catalog`:

| `event_type`                | Emitted by                                                        | Consumed by                                |
|-----------------------------|-------------------------------------------------------------------|--------------------------------------------|
| `tool_invocation_complete`  | Universal post-tool hook in agent-claw (one per MCP / builtin call) | `tool_result_extractor` (per-tool dispatch) |
| `extracted_fact`            | Any extractor projector after writing a `facts` row               | `investigation_scorer`, `kg_facts_sync`     |
| `anomaly_observed`          | `anomaly_detector`                                                | `investigation_scorer`, `hypothesis_former` |
| `pattern_detected`          | `pattern_detector` (cron)                                         | `hypothesis_former`, `wiki_regen`           |
| `interpretation_proposed`   | `interpreter` (LLM projector)                                     | `investigation_scorer`, `wiki_regen`        |
| `investigation_requested`   | `investigation_scorer` (when score ≥ threshold)                   | `interpreter`, `hypothesis_former`          |
| `test_planned`              | `test_planner`                                                    | `workflow_engine`                           |
| `external_data_fetched`     | External-feed cron daemons (CrossRef, PubMed, USPTO, ORD)         | `doc_ingester` or direct extractor          |

All except `tool_invocation_complete` carry the `fact_id` of the
producing/triggering fact, so downstream projectors do a single
`SELECT … FROM facts WHERE id = $1` to materialise context.

`tool_invocation_complete` payload schema:

```json
{
  "tool_name": "string",          // e.g. "xtb.compute_barrier"
  "user_entra_id": "string",
  "project_id": "uuid|null",
  "args": { ... redacted ... },
  "result": { ... typed ... },
  "result_schema_id": "string",   // for extractor lookup
  "duration_ms": 0,
  "ok": true,
  "error": null
}
```

(Failure path emits the same event with `ok: false`; the negative-result
extractor handles it.)

#### 4.1.4 New tables

```sql
-- Extractor registry: per-tool / per-source dispatch
CREATE TABLE extraction_registry (
  source_kind       TEXT NOT NULL,          -- 'mcp_tool' | 'ingestion' | 'workflow'
  source_name       TEXT NOT NULL,          -- e.g. 'mcp-xtb.compute_barrier'
  result_schema_id  TEXT NOT NULL,          -- discriminator on result shape
  extractor_module  TEXT NOT NULL,          -- e.g. 'services.projectors.fact_extractor.xtb'
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  promote_default   BOOLEAN NOT NULL DEFAULT TRUE,  -- false for volume-bombing sources
  PRIMARY KEY (source_kind, source_name, result_schema_id)
);

-- Investigation queue (scored, deferred)
CREATE TABLE investigation_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id         UUID NOT NULL REFERENCES facts(id),
  project_id      UUID,
  score           NUMERIC(4,3) NOT NULL,
  reason_codes    TEXT[] NOT NULL,           -- ['novel','anomaly','priority']
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked_at       TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  outcome         TEXT                       -- 'interpreted','no_action','budget_exhausted'
);
CREATE INDEX idx_investigation_queue_pending
  ON investigation_queue (score DESC) WHERE picked_at IS NULL;

-- Active-hypothesis caps + investigation budgets are read from config_settings;
-- consumption is tracked in this table for the daily window.
CREATE TABLE investigation_budget_usage (
  scope           TEXT NOT NULL,             -- 'global'|'org'|'project'|'user'
  scope_id        TEXT NOT NULL,
  date_utc        DATE NOT NULL,
  llm_usd_spent   NUMERIC(8,3) NOT NULL DEFAULT 0,
  cpu_hours_spent NUMERIC(8,3) NOT NULL DEFAULT 0,
  facts_extracted INT          NOT NULL DEFAULT 0,
  hypotheses_proposed INT      NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, scope_id, date_utc)
);
```

#### 4.1.5 New `config_settings` keys

```
kg.auto_extraction.enabled                       (bool, default true)
kg.extractor_reliability.{observed|computed|interpreted|hypothesized|abstracted}
                                                 (numeric, defaults in §3.2)
investigation.score_threshold_sync               (numeric, default 0.70)
investigation.score_anomaly_weight               (numeric, default 0.45)
investigation.score_novelty_weight               (numeric, default 0.35)
investigation.score_priority_weight              (numeric, default 0.20)
investigation.sweep_interval_minutes             (int, default 15)
investigation.pattern_sweep_interval_hours       (int, default 24)
investigation.max_active_hypotheses_per_project  (int, default 12)
investigation.daily_llm_budget_usd               (numeric, default 50)
investigation.daily_cpu_hours_budget             (numeric, default 100)
investigation.max_derivation_depth               (int, default 4)
extraction.<tool_name>.promote_to_kg             (bool, per-tool override)
external.crossref.poll_minutes                   (int, default 60)
external.pubmed.poll_minutes                     (int, default 60)
external.uspto.poll_hours                        (int, default 24)
external.ord_io.poll_hours                       (int, default 24)
```

All knobs resolve user → project → org → global per existing `ConfigRegistry`.

### 4.2 The universal extraction surface

The load-bearing addition is one new post-tool hook plus one new generic
projector. They replace and generalize the existing `source-cache` hook
without removing it (`source-cache` becomes a special case).

#### 4.2.1 New post-tool hook: `tool-invocation-emitter`

Fires on **every** tool call, success or failure. Hook implementation:

```ts
// services/agent-claw/src/core/hooks/tool-invocation-emitter.ts
export function registerToolInvocationEmitterHook(lifecycle, deps) {
  lifecycle.on('post_tool', async (input, _id, { signal }) => {
    if (!await isFeatureEnabled('kg.auto_extraction.enabled', input.ctx)) return {};
    if (input.tool.is_internal) return {};  // skip manage_todos, ask_user, etc.

    await deps.pool.query(
      `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
       VALUES ('tool_invocation_complete', 'tool_invocations', $1,
               jsonb_build_object(
                 'tool_name', $2,
                 'user_entra_id', $3,
                 'project_id', $4,
                 'args', $5::jsonb,
                 'result', $6::jsonb,
                 'result_schema_id', $7,
                 'duration_ms', $8,
                 'ok', $9,
                 'error', $10
               ))`,
      [input.invocation_id, input.tool.name, input.ctx.user, input.ctx.project,
       input.redacted_args, input.redacted_result, input.tool.result_schema_id,
       input.duration_ms, input.ok, input.error]);

    return {};
  });

  lifecycle.on('post_tool_failure', /* same shape; ok=false */);
}
```

The hook is wired identically to `source-cache` today; both run. The
existing `source-cache` hook stays for backward compatibility and for
the specific ELN/LIMS/instrument cache-warming behavior that the new
generic hook does not replicate.

#### 4.2.2 New projector: `tool_result_extractor`

Listens on `ingestion_events` for `tool_invocation_complete`. Looks up
`(source_kind='mcp_tool', source_name=tool_name, result_schema_id)` in
`extraction_registry`. If found and enabled and (`promote_default` or
explicit per-call `promote_to_kg=true`), dynamically imports
`extractor_module` and calls
`extract(result: dict, ctx: ExtractionContext) -> list[Fact]`.

Each extracted fact is INSERTed into `facts` and an `extracted_fact`
event is emitted (which triggers the rest of the loop).

This means: **adding KG support for a new MCP tool = writing one Python
function and registering it.** No new projector, no new event type, no
schema migration.

#### 4.2.3 Per-source extractor catalog (Phase 1 deliverables)

One extractor module per MCP tool. All live under
`services/projectors/fact_extractor/<tool>.py` and share a base class.

```
Family 1  Documents & literature
  - doc_extractor                 (LLM over contextual chunks)
  - figure_extractor              (LLM over extracted figure text + caption)
  - table_extractor               (LLM over extracted tables; rules + LLM)

Family 2  ELN
  - eln_experiment_extractor      (mock_eln.experiments)
  - eln_reaction_extractor        (mock_eln.reactions; yields, conditions)
  - eln_sample_extractor          (mock_eln.samples; purity, structure links)
  - eln_entry_extractor           (mock_eln.entries; LLM on free-text notes)

Family 3  Analytical (LOGS-by-SciY)
  - hplc_extractor                (peaks, areas, retention, purity)
  - nmr_extractor                 (chemical shifts, multiplicities, integration)
  - ms_extractor                  (m/z peaks, isotope patterns, fragmentation)

Family 4  Structure / mechanism
  - xtb_extractor                 (energies, barriers, GFN level)
  - crest_extractor               (conformer counts, Boltzmann weights)
  - synthegy_extractor            (mechanism arrows, intermediates, TS barriers)
  - sirius_extractor              (candidate structures + scores)

Family 5  Retrosynthesis / forward
  - aizynth_extractor             (routes, building blocks, route scores)
  - askcos_extractor              (forward predictions, reagent suggestions)

Family 6  ML property prediction
  - chemprop_extractor            (predictions + calibrated std)
  - tabicl_extractor              (predictions; flag domain drift)
  - applicability_extractor       (in-domain / out-of-domain verdicts)
  - yield_baseline_extractor      (baseline yield + residual vs. observed)

Family 7  Generative
  - genchem_extractor             (every candidate as derivation_class=COMPUTED;
                                   bulk-mode INSERT; flagged ABSTRACTED for
                                   "library was generated" rollup fact)

Family 8  Optimization
  - bo_round_extractor            (suggest/observe rounds; Pareto front membership)
  - chrom_method_extractor        (Pareto front per gradient/T)
  - plate_designer_extractor      (plate layout decisions as facts on the campaign)

Family 9  Workflow / campaign
  - workflow_run_extractor        (already partly covered by kg_experiments;
                                   gains step-level facts)
  - synthesis_campaign_extractor  (step transitions as facts on the campaign)

Family 10 Agent-internal
  - agent_conclusion_extractor    (LLM-internal conclusions promoted via the
                                   new `promote_to_kg` builtin or implicit
                                   "I conclude that …" detector in post_turn)

Family 11 Validation
  - forged_tool_validation_extractor   (each run → fact on the tool)
  - skill_promotion_extractor          (each promotion event → fact on the skill)

Family 12 External
  - crossref_extractor            (DOI metadata as facts on the document)
  - pubmed_extractor              (abstract + MeSH terms as facts)
  - uspto_extractor               (patent abstracts, examples → reactions)
  - ord_extractor                 (ORD records as canonical reactions)
```

The extractor signature is identical across all:

```py
@dataclass
class ExtractionContext:
    tool_name: str
    user_entra_id: str
    project_id: UUID | None
    args: dict
    invocation_id: str
    duration_ms: int

def extract(result: dict, ctx: ExtractionContext) -> list[FactDraft]: ...
```

`FactDraft` is the typed Pydantic shape that becomes a `facts` row.
Extractors are pure functions; they never touch the DB. The shared
projector handles persistence, dedup, and event emission.

### 4.3 The investigation loop

#### 4.3.1 Scorer

For each `extracted_fact`, compute:

```
novelty_score   = 1.0 - jaccard(fact, k-nearest existing facts on (subject, predicate))
anomaly_score   = clamp(|fact.value - KG_expected.mean| / KG_expected.std, 0, 1)
                  (default 0 if no prior; clamps the z-score into [0,1])
priority_score  = project.priority_tier (HIGH=1.0, MED=0.5, LOW=0.2)
investigation_score = w_n * novelty + w_a * anomaly + w_p * priority
```

Weights from `config_settings`. If `score ≥ threshold_sync`, emit
`investigation_requested` immediately. Otherwise queue.

#### 4.3.2 Interpreter (LLM)

Listens on `investigation_requested`. For each request:

1. Loads the source fact + k-hop KG neighborhood (k=2 default).
2. Loads relevant wiki page excerpts (already exists via `search_knowledge`).
3. Calls LiteLLM with `prompt_registry` key `kg.fact_interpretation` and a
   schema-constrained output (Pydantic):
   ```json
   {
     "interpretations": [
       {
         "claim": "string",
         "predicate": "string",
         "supports_existing_fact_ids": ["uuid"],
         "contradicts_existing_fact_ids": ["uuid"],
         "self_confidence": 0.0
       }
     ],
     "gaps_identified": [
       {
         "missing_predicate": "string",
         "suggested_tool": "mcp-xtb.compute_barrier" | ...,
         "suggested_args": { ... }
       }
     ]
   }
   ```
4. Each `interpretation` becomes a new `facts` row with
   `derivation_class = INTERPRETED`, `confidence = source.conf × 0.75 ×
   self_confidence`, `source_fact_ids = [source.id]`.
5. Each `gap` becomes a queued task via `test_planner` (see §4.3.5).

LLM budget is debited from `investigation_budget_usage` per call.

#### 4.3.3 Anomaly detector

Runs in the same projector as the scorer. For numeric facts with a
populated KG-expected range, computes z-score, and if `|z| > anomaly_z_threshold`
(default 2.0) emits `anomaly_observed` with `polarity = anomaly`. Anomaly
facts always go through interpretation regardless of base score.

#### 4.3.4 Pattern detector (nightly)

A daemon (`services/optimizer/pattern_detector/`) that runs every
`investigation.pattern_sweep_interval_hours` and, per project:

1. Pulls all `OBSERVED`/`COMPUTED` facts written in the last 7 days.
2. Groups by `(subject_label, predicate)` and looks for:
   - Clusters with statistically significant means vs. KG-wide baseline.
   - Substrate-class effects (joining via `compound_class_assignments`).
   - Yield drops correlated with specific reagent/solvent classes.
3. Emits one `pattern_detected` event per significant cluster, with a
   `pattern_summary` payload that goes through the interpreter to produce
   an `ABSTRACTED` fact + a wiki contradiction/pattern page (extending
   the existing `wiki_linter` mechanism).

#### 4.3.5 Hypothesis former

Listens on `anomaly_observed` and `pattern_detected`. Calls LiteLLM
with `prompt_registry` key `kg.hypothesis_formation` and a constrained
schema. Each output hypothesis goes through the existing
`propose_hypothesis` path (so it lands in the `hypotheses` table and
the `kg_hypotheses` projector chain stays intact). Class is set to
`HYPOTHESIZED`. Bounded by per-project active cap.

#### 4.3.6 Test planner

Listens on `hypothesis_proposed`. For each active hypothesis, calls
LiteLLM with `prompt_registry` key `kg.test_planning` and a constrained
schema asking for **discriminating** tests (i.e., a test whose outcome
distinguishes the hypothesis from competing ones). Each test becomes
either:

- A direct enqueue on the existing `task_queue` (for chemistry MCPs).
- A `workflow_runs` row (for multi-step plans).
- A synthesis-campaign step (for wet-lab work, gated by a
  `requires_human_approval` flag).

Bounded by per-project compute budget.

### 4.4 Wiki coexistence

ADR 012 already establishes the wiki projection layer with
`<!-- human:begin -->` / `<!-- human:end -->` blocks and the
`wiki-human-block-guard` pre_tool hook. This design extends, doesn't
replace, that contract:

- **Auto-extraction never writes to wiki directly.** All wiki updates
  continue to go through `wiki_regen`, which reads from `facts` and
  preserves human blocks.
- **`HYPOTHESIZED` facts surface only in a "Pending hypotheses"
  section** of the entity page, never in the main body. The
  `wiki.synthesis` prompt is extended to enforce this section boundary.
- **`ABSTRACTED` facts get their own dedicated wiki kind**: `pattern/<slug>`
  and `anomaly/<slug>` pages, automatically stubbed by `wiki_linter`
  when emitted. These cross-link to citing entity pages.
- **Contradiction pages** (existing Phase 4b-ii mechanism) become a
  routine output of the pattern detector, not an exception path.
- **Negative-result facts** (`polarity = negative`) get a dedicated
  "Negative results" section on the entity page, never mixed with
  positive observations.

### 4.5 Budgets & cycle prevention

The system has three orthogonal protections against runaway:

1. **Class-based capability gates** (§3.2). A `HYPOTHESIZED` fact cannot
   itself spawn a new hypothesis; an `ABSTRACTED` fact cannot trigger
   compute. So a derivation chain hits a capability wall after at most
   one interpretation + one hypothesis + one test cycle without a fresh
   `OBSERVED`/`COMPUTED` input.
2. **Confidence decay** (§3.2). Multiplicative decay drops confidence
   below action thresholds within 4–5 derivations regardless of class.
3. **Budgets** (§4.1.5). Every LLM call and compute job debits a
   daily-window budget at user / project / org / global scope. When
   exhausted, the affected operation queues with
   `outcome='budget_exhausted'` and surfaces via Grafana.

Plus the deterministic safeguard:
`investigation.max_derivation_depth` (default 4) is a hard cap
enforced in the `facts` INSERT trigger. Beyond this, the fact lands
with `derivation_class = ABSTRACTED` and the wiki-only privilege set,
regardless of what the extractor requested.

### 4.6 External data feeds

One feed daemon per source (`services/optimizer/external_feeds/<name>/`),
all sharing a base class:

```py
class ExternalFeed:
    poll_interval_minutes: int
    def discover(self) -> list[ExternalRecord]: ...
    def fetch(self, record) -> dict: ...
    def to_canonical(self, fetched) -> CanonicalDocument | CanonicalReaction: ...
```

The `to_canonical` step writes into the existing canonical tables
(`documents`, `reactions`, etc.), which means existing ingestion events
fire normally and existing projectors pick the data up — no new
extractor layer needed for external data. The feed daemon only handles
*acquisition*.

Phase ordering:
- **CrossRef** + **PubMed abstracts** + **ORD** are clearly licensable
  for storage. In Phase 2.
- **USPTO patents** are public-domain. In Phase 2.
- **Journal full text** depends on subscriptions; default off, opt-in
  per tenant via `config_settings`. Still in Phase 2 by capability
  (extractor + ingester ready); off by default.

## 5. Component map

```
NEW components (this design adds):
  hooks/
    tool-invocation-emitter.yaml                      (post_tool/_failure)
  services/agent-claw/src/core/hooks/
    tool-invocation-emitter.ts
  services/agent-claw/src/tools/builtins/
    promote_to_kg.ts                                  (explicit fact promotion)
    request_investigation.ts                          (manual deep-dive request)
  services/projectors/
    tool_result_extractor/                            (dispatching projector)
    fact_extractor/                                   (one module per source family)
      doc_extractor.py
      eln_*.py
      hplc_extractor.py
      nmr_extractor.py
      ms_extractor.py
      xtb_extractor.py
      crest_extractor.py
      synthegy_extractor.py
      sirius_extractor.py
      aizynth_extractor.py
      askcos_extractor.py
      chemprop_extractor.py
      tabicl_extractor.py
      applicability_extractor.py
      yield_baseline_extractor.py
      genchem_extractor.py
      bo_round_extractor.py
      chrom_method_extractor.py
      plate_designer_extractor.py
      synthesis_campaign_extractor.py
      agent_conclusion_extractor.py
      forged_tool_validation_extractor.py
      skill_promotion_extractor.py
      crossref_extractor.py
      pubmed_extractor.py
      uspto_extractor.py
      ord_extractor.py
    investigation_scorer/                             (scorer + anomaly)
    interpreter/                                      (LLM)
    hypothesis_former/                                (LLM)
    test_planner/                                     (LLM + workflow_engine)
    pattern_detector/                                 (cron daemon)
    kg_facts_sync/                                    (mirrors facts → Neo4j)
  services/optimizer/external_feeds/
    crossref_feed/
    pubmed_feed/
    uspto_feed/
    ord_feed/
  db/init/
    62_facts_table.sql
    63_extraction_registry.sql
    64_investigation_queue.sql
    65_derivation_class_columns.sql
    66_facts_neo4j_sync_marker.sql
    67_investigation_event_catalog.sql
    68_investigation_budget_usage.sql
  db/seed/
    09_extraction_registry_seed.sql                   (one row per shipped extractor)
    10_kg_fact_interpretation_prompt.sql
    11_kg_hypothesis_formation_prompt.sql
    12_kg_test_planning_prompt.sql
    13_kg_pattern_summary_prompt.sql

CHANGED components (existing, modified by this design):
  services/agent-claw/src/core/hooks/source-cache.ts
    → unchanged behavior; runs alongside the new universal hook.
  services/projectors/wiki_pages/  +  wiki_regen/
    → consume new event types (anomaly_observed, pattern_detected,
       extracted_fact for entity pages); honor "Pending hypotheses"
       section boundary.
  services/projectors/wiki_linter/
    → auto-stubs anomaly/<slug> and pattern/<slug> pages.
  services/projectors/qm_kg/, kg_experiments/, kg_hypotheses/,
  kg_documents/, kg_source_cache/
    → each gains a `facts` row INSERT alongside its Neo4j write
       (idempotent on (extractor_name, source_table, source_row_id)).
  hooks/ + MIN_EXPECTED_HOOKS bump in services/agent-claw/src/bootstrap/start.ts
  services/agent-claw/src/core/hook-loader.ts
    → +1 BUILTIN_REGISTRARS entry.
```

## 6. Phasing

Each phase is independently shippable behind feature flags. All eight
phases together complete the design; no phase is conditional on
external dependencies.

| Phase | Scope                                                                                              | Gating flag                     | Approx. PRs |
|-------|----------------------------------------------------------------------------------------------------|---------------------------------|-------------|
| **0** | Schema (`facts`, registry, queue, derivation_class columns); empty `tool_result_extractor`         | `kg.auto_extraction.enabled=false` | 1–2         |
| **1** | Universal post-tool hook; per-tool extractors for chemistry MCPs (xtb, aizynth, askcos, chemprop, applicability, yield_baseline, sirius, crest, synthegy, tabicl, ord_io, plate, chrom_method, reaction_optimizer); deterministic extractors only | Per-tool sub-flags                | 5–8         |
| **2** | Document fact extraction (LLM); ELN extractors over `mock_eln.*`; LOGS extractors; external feeds (CrossRef + PubMed + USPTO + ORD); genchem extractor (with `promote_to_kg` default-on) | `kg.auto_extraction.documents`, `.eln`, `.logs`, `.external.*` | 4–6 |
| **3** | Investigation scorer + anomaly detector + interpreter LLM; surfaces but does not yet trigger compute | `kg.investigation.interpret_enabled` | 3–4 |
| **4** | Pattern detector daemon; auto-hypothesis-formation; budget enforcement                             | `kg.investigation.pattern_enabled`, `.hypothesis_enabled` | 2–3 |
| **5** | Test planner; workflow_engine integration; full chemist loop closed                                | `kg.investigation.test_planning_enabled` | 2–3 |
| **6** | Agent-internal conclusion extraction; meta-facts (forged-tool validation, skill promotion)         | `kg.auto_extraction.agent_internal`, `.meta` | 1–2 |
| **7** | Wiki: anomaly / pattern / pending-hypotheses sections; contradiction page automation               | `wiki.contradiction_auto`       | 1–2 |

Phase 0 lands the substrates; Phase 1 demonstrates the universal pipe
end-to-end on a single representative extractor (xtb), then fans out;
Phases 3–5 light up the autonomy.

## 7. Test plan

- **Unit tests per extractor.** Each extractor is a pure function; tests
  feed a typed result payload and assert the produced `FactDraft` list.
- **Projector replay tests.** Existing `tests/integration/test_projector_replay_idempotency.py`
  pattern extended to every new projector. Wipe `projection_acks`,
  re-derive, assert byte-for-byte equality of resulting `facts` rows.
- **Cycle-detection harness.** Synthesize a chain of derivations and
  assert the multiplicative decay + class cap together prevent
  `HYPOTHESIZED → HYPOTHESIZED` and that depth ≥ 4 hits the
  `ABSTRACTED` wall.
- **Budget enforcement tests.** Inject a synthetic 100-fact burst,
  assert `investigation_budget_usage` is respected and excess goes to
  the queue with `outcome='budget_exhausted'`.
- **End-to-end chemist-loop smoke** (`scripts/smoke-chemist-loop.sh`):
  ingest a synthetic ELN row with an anomalous yield, assert (1) an
  `extracted_fact` lands, (2) the scorer flags it `anomaly`, (3) the
  interpreter produces an `INTERPRETED` fact, (4) the hypothesis
  former produces a `HYPOTHESIZED` row, (5) the test planner enqueues
  at least one discriminating test on the queue. All within 30 s in
  dev mode (with cached LLM responses).
- **RLS tests.** `facts` table has the same RLS test coverage as
  existing project-scoped tables.

## 8. Risks & open questions

1. **LLM-driven extraction over documents is the costliest pipe.** A
   single 100-page PDF can yield hundreds of LLM calls if the prompt
   asks for per-chunk fact extraction. Mitigation: chunk-aware batching
   (one LLM call per ~10 chunks); rate-limit per source per day; degrade
   gracefully when budget exhausted (skip fact extraction, keep
   embedding-only).
2. **Genchem volume bombing.** A `generate_focused_library` call can
   return 10k candidates. The `genchem_extractor` will emit one
   `ABSTRACTED` rollup fact ("library X was generated with 10k members")
   *plus* per-candidate `COMPUTED` facts that go directly into the
   queue with low priority — they're recorded but never trigger LLM
   interpretation unless a downstream tool surfaces one. KG growth is
   bounded by indexes, not capability gates.
3. **External feed reliability.** PubMed / CrossRef rate-limit
   aggressively. Feed daemons must back off; outages must not block
   the chemist loop.
4. **Hallucinated facts from LLM interpreter.** Schema-constrained
   output + `derivation_class = INTERPRETED` + multiplicative decay
   makes these *recorded but de-prioritized*. The wiki regen does cite
   them, but they cannot themselves spawn new hypotheses. Worst case:
   junk in the wiki, fixable via the existing curator builtins.
5. **Cycle in test planning.** A hypothesis spawns a test that emits a
   fact that triggers the same hypothesis again. Capability gates
   already prevent the *direct* cycle (a `HYPOTHESIZED` fact can't
   spawn another). But an `OBSERVED` measurement that re-confirms an
   old hypothesis *will* trigger a new interpretation pass. Mitigation:
   the interpreter checks `supports_existing_fact_ids` and if an
   existing hypothesis is supported, it emits a "support" relationship
   rather than a new claim. Per-hypothesis support-count is capped to
   prevent infinite reaffirmation cycles.
6. **Postgres vs. Neo4j as source of truth.** `facts` table is the new
   source of truth; existing direct-driver projectors must be migrated
   to write to Postgres first. This is the trickiest migration. Plan:
   one projector at a time, write to both, then flip reads, then
   remove the Neo4j-only write path.
7. **Open question: real ELN tenants** (not `mock_eln`). The ELN
   extractor signatures generalize, but real-tenant tables aren't
   stable yet. Phase 2 ships the `mock_eln` extractors; real ELN is a
   follow-up plan.
8. **Open question: agent-internal "conclusion" detection.** Do we
   detect conclusions implicitly (post_turn LLM pass over the agent's
   own output) or only via explicit `promote_to_kg` calls? Implicit
   is more comprehensive but ~doubles per-turn cost. Default to
   explicit in Phase 1; consider implicit in Phase 6.

## 9. Out of scope (for this spec)

- Real ELN / LIMS tenant integration beyond `mock_eln`. (Separate plan.)
- Multi-tenant KG sharding. (Existing single-Neo4j-instance assumption
  holds.)
- Active learning over the extracted facts to retrain ML models
  (`mcp-chemprop` recalibration loop). Worth a follow-up plan; out of
  scope here.
- Human-in-the-loop review queues for hypothesis approval. The current
  design auto-proposes; a human-approval gate is configurable but not
  the default.

## 10. Approval checklist (for the user)

Please confirm:

- [ ] Loop architecture (§3.1) matches your mental model of the chemist
      loop.
- [ ] Two-axis confidence model (§3.2) — capability gates + decay — is
      the right safety design.
- [ ] All twelve source families (§4.2.3) are in scope from Phase 1–2,
      with no deferrals.
- [ ] Constitutional invariants (§3.3) capture the right rules.
- [ ] Phasing (§6) is acceptable.

Once approved, the next step is invoking the writing-plans skill to
turn this into a concrete, file-by-file implementation plan.
