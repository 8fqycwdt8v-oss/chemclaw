# Deep review — knowledge graph + agent knowledge generation

Date: 2026-05-10
Branch: `claude/review-knowledge-graph-gp779`
Scope: the canonical → projector → Neo4j path, plus the agent's pipeline that
produces hypotheses, artifacts, skills, and confidence-scored claims.

This is a structural / quality review against `CLAUDE.md`'s stated invariants.
It is **not** a security review (covered separately under `docs/review/2026-05-05/`).

Findings are prioritised: **Critical** (correctness / drift from a documented
invariant), **High** (consistency or operational risk), **Medium** (cleanup
worth doing), **Low** (cosmetic).

---

## 1. KG implementation

### 1.1 Schema map (verified)

| Layer | File | What it carries |
|---|---|---|
| Event spine | `db/init/01_schema.sql` | `ingestion_events`, `projection_acks`, base canonical tables (`compounds`, `reactions`, `documents`, `document_chunks`) |
| Hypotheses | `db/init/03_hypotheses.sql` | `hypotheses.confidence` NUMERIC(4,3) + `confidence_tier` `TEXT GENERATED ALWAYS AS` (3-tier: high/medium/low) at `03_hypotheses.sql:13` |
| Bi-temporal + confidence | `db/init/17_unified_confidence_and_temporal.sql` | Adds `valid_from`/`valid_to`/`invalidated`/`confidence_score` to reactions; adds same to `artifacts` (table-existence-guarded — see §1.5); adds `maturity` to `skill_library` and `forged_tool_tests` |
| Event vocabulary | `db/init/35_event_type_vocabulary.sql` | Enumerates the event types projectors react to |
| Refutation cascade | `db/init/36_fact_invalidated_emitter.sql` | Trigger emits `fact_invalidated` when hypotheses status changes |
| QM channel | `db/init/37_qm_ingestion_events.sql` | Establishes the `qm_job_succeeded` custom NOTIFY channel |
| Document consumer | `db/init/38_kg_documents_consumer.sql` | Registers `document_ingested` event type — but the projector that reads it is undeployed (§1.4) |

### 1.2 Projector inventory (verified by reading each `main.py`)

| Projector | `name` | Listen mode | Write target | Override `_connect_and_run`? |
|---|---|---|---|---|
| `kg_experiments` | `kg_experiments` | `experiment_imported` (base loop) | mcp-kg via `KGClient.write_fact` (REST) | No |
| `kg_hypotheses` | `kg_hypotheses` | `hypothesis_proposed`, `hypothesis_status_changed` (base loop) | **Direct** Neo4j via `AsyncGraphDatabase` | No |
| `kg_documents` | **`kg-documents`** (hyphen — §1.6) | `document_ingested` (base loop) | **Direct** Neo4j via `AsyncGraphDatabase` | No |
| `qm_kg` | `qm_kg` | Custom channel `qm_job_succeeded` + base | **Direct** Neo4j via `AsyncGraphDatabase` | **Yes** (`qm_kg/main.py:80`) |
| `kg_source_cache` | `kg_source_cache` | `source_fact_observed` (base loop) | mcp-kg via `KGClient.write_fact` (REST) | No |
| `compound_fingerprinter` | `compound_fingerprinter` | Custom channel (payload = inchikey) | Postgres `compounds` + `compound_substructure_hits` | **Yes** (`compound_fingerprinter/main.py:68`) |
| `compound_classifier` | `compound_classifier` | Custom channel `compound_fingerprinted` | Postgres `compound_class_assignments` | **Yes** (`compound_classifier/main.py:53`) |
| `chunk_embedder` | `chunk_embedder` | `document_chunk_created` | `document_chunks.embedding` (BGE-M3) | No |
| `contextual_chunker` | `contextual_chunker` | `document_chunk_created` | semantic refinement | No |
| `reaction_vectorizer` | `reaction_vectorizer` | `reaction_recorded` | `reactions.drfp_vector` | No |
| `conditions_normalizer` | `conditions_normalizer` | `experiment_imported` | `reaction_conditions` | No |

### 1.3 Mixed Neo4j write path — *Critical*

The KG has **two parallel write paths into Neo4j**:

- **Path A — through mcp-kg REST.** Used by `kg_experiments` and
  `kg_source_cache` (both hold a `KGClient` and call
  `POST /tools/write_fact`). The mcp-kg service centralises tenant
  scoping (`group_id`), provenance wrapping, idempotency on `fact_id`
  uniqueness (`mcp_kg/cypher.py:83`), and the bi-temporal MERGE pattern.

- **Path B — direct Neo4j driver.** Used by `kg_hypotheses`,
  `kg_documents`, and `qm_kg`. Each holds its own
  `AsyncGraphDatabase.driver(...)` and writes via raw Cypher
  (`kg_hypotheses/main.py:38`, `kg_documents/main.py:89`,
  `qm_kg/main.py:316`).

Consequences observed:

1. **Tenant isolation is not uniformly enforced.** mcp-kg's
   write/query/invalidate paths filter by `group_id`. The direct-driver
   projectors set `group_id` themselves on each MERGE; if a future
   maintainer omits it, leakage is silent — there is no shared guard.
2. **Idempotency is not uniformly enforced.** mcp-kg relies on the
   `fact_id` uniqueness constraint registered at bootstrap
   (`mcp_kg/cypher.py:66`). The direct-driver projectors carry their
   own MERGE keys (e.g. `qm_kg/main.py:332` keys on
   `{method, task, job_id}`); a constraint mismatch between bootstrap
   and a projector's MERGE key would let duplicates through.
3. **Invalidation paths can race.** `kg_hypotheses/main.py:171` sets
   `invalidated_at` on `:CITES` edges directly, while the agent and
   other writers go through `mcp-kg /tools/invalidate_fact`. There is
   no shared transaction or version stamp, so a stale invalidate that
   beats the cascade is possible.

**Recommendation:** route every KG write through `mcp-kg`'s REST API.
The cost is one HTTP hop per fact (already paid by `kg_experiments`);
the benefit is a single place to evolve schema, constraints, tenant
filters, and the Neo4j driver pin. If perf-critical projectors need a
faster path, expose a batched `write_facts` endpoint rather than
duplicate the driver across services.

### 1.4 `kg_documents` is built but undeployed — *Critical*

`services/projectors/kg_documents/main.py` exists with a `Dockerfile`,
declares `interested_event_types = ("document_ingested",)`, and
`db/init/38_kg_documents_consumer.sql` registers the event type. But
`docker-compose.yml` does **not** include a `kg_documents` service
(verified by exhaustive grep — only `kg_experiments`, `kg_hypotheses`,
`kg_source_cache`, `qm_kg`, plus the non-KG projectors are present).

Effect: `:Document` and `:Chunk` nodes never enter the graph in any
running deployment. Any agent reasoning that depends on chunk-level
KG citations is silently degraded to "no documents in graph".

**Recommendation:** add the `kg_documents` service to compose (and to
the helm chart at `infra/helm/`) or remove the projector and the
consumer SQL. Whichever is chosen, add a startup assertion to the
agent that fails loudly if `:Document` nodes are absent and a tool
that requires them is called.

### 1.5 `reactions.invalidated` is dead, `artifacts` cols are conditional — *High*

- `db/init/17_unified_confidence_and_temporal.sql` adds
  `reactions.invalidated BOOLEAN`, but no projector or builtin ever
  writes it. Invalidation lives at the Neo4j edge level
  (`kg_hypotheses/main.py:171` sets `invalidated_at` on `:CITES`
  edges; mcp-kg's `invalidate_fact` flips edge properties). The
  Postgres column is a misleading affordance — a developer querying
  `reactions WHERE NOT invalidated` will get an answer that diverges
  from what's actually in the graph.

- The bi-temporal columns on `artifacts` are added inside a
  `DO $$ … IF to_regclass('public.artifacts') IS NOT NULL`
  guard (`17_unified_confidence_and_temporal.sql:90`). The base
  table is created elsewhere; if those init files run out of order
  or one is skipped, `artifacts` exists without the bi-temporal
  columns and `compute_confidence_ensemble` (which writes
  `confidence_ensemble JSONB` at `compute_confidence_ensemble.ts:157`)
  / `tag-maturity` (which inserts at `tag-maturity.ts:122`) silently
  skip the temporal stamping.

**Recommendation:** drop `reactions.invalidated` (or document it as
"never used; see Neo4j edge `invalidated_at`"). For `artifacts`,
move the bi-temporal columns into the base table definition and
delete the conditional guard.

### 1.6 Naming inconsistency: `kg-documents` vs `kg_*` — *Medium*

`kg_documents/main.py:81` declares `name = "kg-documents"` (hyphen);
every other projector uses underscores, and `name` is the
`projection_acks` lookup key. The hyphen variant is technically
fine — Postgres column values don't care about the dash — but the
inconsistency means a developer running the documented replay
recipe verbatim:

```sql
DELETE FROM projection_acks WHERE projector_name='kg_documents';
```

…silently no-ops. CLAUDE.md and the runbooks refer to projectors
with underscore names throughout.

**Recommendation:** rename to `kg_documents`. One projector, no
in-flight clients, one-line change.

### 1.7 `qm_kg` declares two listen sources — *Medium*

`qm_kg/main.py:67` sets `name = "qm_kg"`, line 70 sets
`interested_event_types = ("qm_job_succeeded",)`, **and** line 80
overrides `_connect_and_run` to LISTEN on the dedicated
`qm_job_succeeded` channel directly. CLAUDE.md (DR-06) says:

> EITHER set `interested_event_types` and inherit the base
> behaviour, OR override `_connect_and_run` AND give the class a
> docstring that names the channel + payload semantics explicitly.
> No silent divergence.

`qm_kg` does both. The class docstring + inline comments name the
channel (good), but a future maintainer reading
`interested_event_types` will reasonably assume the base
LISTEN-on-`ingestion_events` loop is also firing — and it is not,
because `_connect_and_run` is overridden.

**Recommendation:** drop the `interested_event_types` value (set
to `()`) to match the `compound_fingerprinter` /
`compound_classifier` convention. The override is the only path.

### 1.8 No grep-visible KG read path from the agent — *High*

`services/mcp_tools/mcp_kg/main.py` exposes `query_at_time`,
`invalidate_fact`, `write_fact`, `get_fact_provenance`. No tool in
`services/agent-claw/src/tools/builtins/` calls `query_at_time`. The
agent can write to the KG (via `propose_hypothesis` → trigger →
`kg_hypotheses` projector) and indirectly populate the
`kg_source_cache` view, but there is **no first-class KG read tool**
exposed to the ReAct loop. The agent reasons over Postgres-derived
views (`query_eln_canonical_reactions` etc.) and lets the source-cache
hook reify them as `:Fact` nodes — but the graph itself is read-only
to humans.

This may be intentional (Phase F is source-system-MCP-heavy) but it
is at odds with the design doc's "the agent reads those derived
views at query time" pitch in `CLAUDE.md`. If the KG is meant to
be a primary reasoning surface, an agent-callable
`query_kg_at_time` builtin needs to land.

**Recommendation:** confirm intent. Either (a) wrap `query_at_time`
and `get_fact_provenance` as agent builtins and feed them through
the read-only batch hooks, or (b) document the KG as a downstream
analytical surface (Grafana / human queries) and remove the
"agent reads at query time" framing from the design narrative.

### 1.9 KG test coverage gaps — *Medium*

- Integration tests only exist for `mcp_kg` and `kg_hypotheses`
  (`tests/integration/mcp_kg/test_bitemporal.py`,
  `tests/integration/test_kg_hypotheses_projector.py`). Both gate
  on env vars (`NEO4J_INTEGRATION=1`, `NEO4J_URI`) and silently skip.
- No integration tests for `kg_documents` (consistent with §1.4),
  `qm_kg`, `kg_source_cache`, `compound_fingerprinter`, or
  `compound_classifier`.
- The `fact_invalidated` cascade has a unit test
  (`test_kg_hypotheses_cascade.py`) but no integration test
  exercising the trigger → projector → Neo4j round trip.

**Recommendation:** add a single Docker-gated integration test
per direct-Neo4j projector to lock in MERGE keys / constraint
behaviour. The marginal cost is low (testcontainers harness
already exists at `services/agent-claw/tests/helpers/postgres-container.ts`).

---

## 2. Agent knowledge generation

### 2.1 Confidence ensemble: documentation drift — *High*

`CLAUDE.md` describes a **3-signal** confidence ensemble (Phase C).
The actual implementation in
`services/agent-claw/src/core/confidence.ts` is a **4-signal**
ensemble (verified at `confidence.ts:366-396`):

| Signal | Weight | Source |
|---|---|---|
| `verbalized` | 0.30 | LLM's own confidence field |
| `cross_model` | 0.25 | Judge model agreement at temp=0 |
| `bayesian` | 0.25 | Beta-Binomial posterior over KG prior counts |
| `calibrated` | 0.20 | chemprop ensemble std → confidence (commits 5cb5f63 / 384caa8) |

The 4th signal was added recently (the chemprop std wiring is the
last two merged commits on this branch) and `CLAUDE.md` was not
updated. `extractCalibratedConfidence` at `confidence.ts:279`
parses `predictions[].std`, `ensemble_std`, etc.

The **weight redistribution** path
(`confidence.ts:392-400`) is correct: missing signals drop their
weight from the normaliser. But there is no telemetry on which
signals actually fire in production, so it is hard to know if
`bayesian` (which requires KG prior counts) is ever non-null.

**Recommendation:**
1. Update `CLAUDE.md` → "4-signal confidence ensemble" with the
   weights above.
2. Emit a structured-log event from `composeEnsemble` recording
   which signals contributed (count + weight). Without it, GEPA
   has no signal to recalibrate weights against.
3. The thresholds at `confidence.ts:89-94` (0.85 / 0.65 / 0.40)
   are hardcoded literals; CLAUDE.md mandates `config_settings`
   for tunable knobs. Move to `config_settings` keys
   (`confidence.threshold.foundational` etc.) so tenant
   recalibration doesn't require a redeploy.

### 2.2 `confidence_tier` typing inconsistency — *Medium*

`hypotheses.confidence_tier` is `TEXT GENERATED ALWAYS AS (...)`
(`db/init/03_hypotheses.sql:13`) — a 3-value derived column.
`reactions.confidence_tier` is a **mutable** TEXT (5-value CHECK)
(`db/init/01_schema.sql`); `db/init/17_unified_confidence_and_temporal.sql:10-11`
explicitly comments:

> Tier column stays as mutable TEXT (not converted to GENERATED) to avoid breaking writers.

This is technical debt with consequences:
- A writer can `UPDATE reactions SET confidence_tier='multi_source_llm', confidence_score=0.30`
  and produce an inconsistent row that silently disagrees with the
  hypothesis tier semantics.
- The two tier vocabularies (3-value vs 5-value) require every
  consumer that reads "the confidence tier" to know which table
  it's reading from.

**Recommendation:** unify on the 5-value vocabulary, then convert
`hypotheses.confidence_tier` to GENERATED ALWAYS over the
5-value mapping. Lock in with a CHECK constraint that ties tier
to score range. Tracked as a follow-up in `BACKLOG.md`.

### 2.3 Implicit event emission via DB triggers — *High*

Two builtins write canonical rows but do not emit `ingestion_events`
themselves; they rely on triggers to do it:

- `update_hypothesis_status.ts:14-15` — relies on
  `trg_hypotheses_status_event` (declared in `db/init/35_event_type_vocabulary.sql`)
  to emit `hypothesis_status_changed`.
- `update_synthesis_campaign_step.ts:38` — no explicit event
  emit; the synthesis-campaign tables (`db/init/51_synthesis_campaigns.sql`)
  may carry a trigger but the path is not visible from the builtin.

The **A-on-C invariant** in CLAUDE.md is: "Ingesting worker INSERTs
the row and an `ingestion_events` row." The trigger-driven variant is
acceptable (and arguably cleaner — fewer code paths), but only when
documented at the call site. Today:

1. The dependency on the trigger is invisible to a developer reading
   the builtin.
2. If the trigger is dropped or filtered by a future migration (or
   never gets installed in a fresh environment because the init file
   ordering breaks), event emission silently stops.
3. There is no test exercising "row-inserted-then-event-emitted" for
   either path.

**Recommendation:**
- Add a comment block at the top of every builtin that relies on a
  trigger, citing the trigger name and the init file that creates it.
- Add an integration smoke that asserts each (table, mutation) pair
  emits the expected event, parameterised over the trigger-driven
  callers.

### 2.4 Maturity promotion — present but undocumented — *Medium*

(Note: an earlier read of this branch suggested promotion logic was
absent; that was wrong. It exists.)

- `services/optimizer/skill_promoter/promoter.py` runs the nightly
  EXPLORATORY → WORKING → FOUNDATION promotion for `skill_library`,
  writing `skill_promotion_events` rows
  (`promoter.py:129`, `promoter.py:406`). Gates: shadow_until window
  expiry + golden-set evaluation outcome.
- `POST /api/artifacts/:id/maturity` (`services/agent-claw/src/routes/artifacts.ts:31`)
  is the manual promotion endpoint for individual artifacts.
- `services/optimizer/gepa_runner/{runner.py,gepa.py,metric.py}` is
  the DSPy GEPA trainer that drives prompt promotion via
  `prompt_registry`.

What's missing is **documentation of when each path fires**.
`CLAUDE.md` mentions "skill promotion loop" and "golden + held-out
promotion gate" abstractly; it does not name `skill_promoter` or
`gepa_runner` as the authoritative implementations. A new contributor
reading the CLAUDE.md will spend non-trivial time finding them.

**Recommendation:** add a "Promotion paths" subsection to CLAUDE.md
with the three concrete paths and their cron / trigger conditions.
Cross-link from the runbook for autonomy upgrades.

### 2.5 Hardcoded timeouts everywhere — *Medium*

Builtins under `services/agent-claw/src/tools/builtins/` use literal
TIMEOUT_MS constants per tool — `query_eln_canonical_reactions`
uses 15 000, `design_plate` 60 000, conformer search 1 830 000, etc.
At least 15 distinct values. CLAUDE.md mandates `config_settings`
for tunable knobs.

The `ConfigRegistry` infrastructure is already in place
(`services/agent-claw/src/config/registry.ts`), so this is purely
a migration cost.

**Recommendation:** introduce a single `tool.timeout_ms.<tool_id>`
key convention. Default the registry lookup to the current literal,
then make the literal the fallback inside `getNumber(...)`. No
behavioural change at the default tier; ops gets the knob.

### 2.6 Hooks that shape generated knowledge — verified

The five "knowledge-shaping" hooks behave as documented:

- `tag-maturity` (post_tool, `tag-maturity.ts:47-155`) — stamps
  `maturity: "EXPLORATORY"` on every structured tool output and
  `INSERT`s an `artifacts` row for the seven `ARTIFACT_TOOL_IDS`.
  Verified that `INSERT INTO artifacts` lands at line 122.
- `anti-fabrication` (post_tool) — harvests `fact_id`s from output
  into `ctx.scratchpad.seenFactIds`.
- `foundation-citation-guard` (pre_tool) — denies a tool call that
  declares `maturity_tier: "FOUNDATION"` while citing EXPLORATORY
  artifacts.
- `source-cache` (post_tool, `source-cache.ts`) — emits
  `source_fact_observed` `ingestion_events` rows for query_*/fetch_*
  ELN/instrument tools.
- `redact-secrets` (post_turn, `redact-secrets.ts`) — defense-in-depth
  scrub of the assistant's outbound text.

Two observations:

1. **`redact-secrets` runs at post_turn but Pino logs run earlier.**
   CLAUDE.md (logging section) flags that `err.message` and
   `err.stack` are not redacted today, and the post_turn redactor
   only sees the assistant's `finalText`. Postgres + MCP errors
   regularly carry SMILES + compound codes. This is a known gap
   tracked in the 2026-05-03 deep-review backlog (cluster 6) but is
   re-confirmed here as still open.

2. **`anti-fabrication` is scratchpad-only.** It accumulates
   `seenFactIds` but does not block a tool call that produces a
   claim with a fabricated `fact_id` — the guard is downstream
   (`foundation-citation-guard` only fires on FOUNDATION claims).
   An EXPLORATORY hypothesis that cites a fabricated fact ID will
   pass through cleanly. This is consistent with the
   "exploratory = freedom, foundational = strict" model, but it
   means the KG can accept a hypothesis row whose
   `hypothesis_citations` reference a non-existent fact. There is
   no FK from `hypothesis_citations.fact_id` to a Postgres-side
   facts table (the source of truth is Neo4j), so the constraint
   has to live in application code.

**Recommendation:** add a post_tool guard that, for any tool whose
output declares `surfaced_fact_ids[]`, validates each ID against
the in-turn `seenFactIds` set — and on mismatch, either (a) logs
a structured warning (cheap, low-risk) or (b) demotes the tool
output's `confidence` by a fixed amount. (a) is the right starting
point.

### 2.7 Forged-tool path — verified, scope promotion still TBD — *Medium*

`forge_tool.ts`, `induce_forged_tool_from_trace.ts`,
`add_forged_tool_test.ts`, and the `forged_tool_validator`
optimizer service are all present. The 4-stage Forjador pipeline
runs end-to-end; persisted Python code lives at
`$FORGED_TOOLS_DIR/<uuid>.py`; `skill_library` rows are written
with `kind='forged_tool'`, `active=false`, `shadow_until=NOW()+14d`.

The "weak-from-strong transfer" and "scope promotion" pieces from
Phase D.5 are referenced by the `parent_tool_id` parameter on
`forge_tool` but the version-bump / cross-tenant promotion logic
is not visible in the builtin. It may live in the
`forged_tool_validator` cron path; worth confirming before shipping
new forged tools to a second tenant.

**Recommendation:** write a one-page runbook describing the
forged-tool lifecycle (forge → shadow → validate → promote → fork)
with the file paths for each step. This is one of the riskier
agent capabilities (the agent writes Python that later runs in
sandbox) and a clear lifecycle doc cuts triage time when something
misbehaves.

### 2.8 Smells worth filing in BACKLOG — *Low*

- Confidence thresholds hardcoded (§2.1) → `config_settings`.
- Tool timeouts hardcoded (§2.5) → `config_settings`.
- `kg_documents` projector named with a hyphen (§1.6) → rename.
- `reactions.invalidated` dead column (§1.5) → drop.
- `qm_kg` declares both listen sources (§1.7) → drop one.
- Confidence-signal contribution telemetry (§2.1) → add a structured-log line.
- Fact-ID validation guard (§2.6) → add post_tool log.

---

## 3. Recommended workstream

In priority order, with rough scope:

1. **Unify Neo4j writes through mcp-kg** (§1.3). Largest correctness
   win; touches 3 projectors and adds a batched endpoint. ~2-3 days.
2. **Decide on `kg_documents`** (§1.4). Either add to compose + helm
   or remove. If keeping, add an integration smoke. ~½ day.
3. **Update `CLAUDE.md`** (§2.1, §2.4) — 4-signal ensemble, named
   promotion paths, drop the "3-signal" framing. ~1 hour.
4. **Drop dead column + fix conditional artifacts cols** (§1.5). ~½ day.
5. **Confidence + tool-timeout migration to `config_settings`**
   (§2.1, §2.5). Mostly mechanical. ~1 day.
6. **Trigger-emission documentation + integration smokes** (§2.3). ~½ day.
7. **`kg_documents` rename, `qm_kg` cleanup** (§1.6, §1.7). ~½ hour each.
8. **Fact-ID validation guard** (§2.6). ~½ day including tests.
9. **Forged-tool lifecycle runbook** (§2.7). ~½ day.

Items 1, 2, and 3 are the bar for "the documented architecture
matches the running code." 4–9 are quality cleanup that should land
behind the same wave-3 deep-review banner.
