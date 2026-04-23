# Phase 5 — Sub-project A: Cross-Project Reaction Learning Toolkit

**Date:** 2026-04-23
**Scope:** Phase 5 Sub-project A per `~/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md`
**Status:** Design approved pending final read-through.

## 1. Purpose and deliverable

Give the agent the tools to reason across projects — find reactions across the user's accessible portfolio, pull their reagent/condition/outcome context, run statistical analysis (TabICL v2 in-context learning), synthesize structured insights, and propose citable hypotheses that land in both Postgres (canonical) and Neo4j (projected KG nodes with `CITES` edges to Fact nodes).

As a precondition, collapse the per-mode API surface shipped in Phase 4. The agent becomes one unified surface: one endpoint (`/api/chat`), one system prompt (`agent.system`, rewritten), one tool catalog. The agent picks its own approach and its own response form per request — no user-facing mode selector, no dedicated research/learning endpoints, no per-mode rate limits.

**Demo at end:** a user asks "across all my projects, what conditions maximize yield for Suzuki couplings on electron-poor aryls?" on `/api/chat`. The agent autonomously retrieves a cross-project reaction set (`find_similar_reactions`), expands context (`expand_reaction_context`), fits TabICL in-context over the set (`statistical_analyze` → `mcp-tabicl`), drafts 1–N hypotheses citing Fact IDs (`propose_hypothesis`), and answers inline — optionally with a fenced chart block for the numeric comparison. Each hypothesis lands as a row in `hypotheses` and a `Hypothesis` node in Neo4j linked via `CITES` to the cited facts.

## 2. In scope / explicitly out of scope

**In scope:**
- 4 new agent tools: `expand_reaction_context`, `statistical_analyze`, `synthesize_insights`, `propose_hypothesis`
- 1 new MCP service: `mcp-tabicl` (TabICL v2 inference + reaction featurizer)
- 1 new canonical table pair: `hypotheses` + `hypothesis_citations`, RLS-enabled, emitting `hypothesis_proposed` / `hypothesis_status_changed` events
- 1 new projector: `kg-hypotheses` (canonical → Neo4j `Hypothesis` nodes + `CITES` edges)
- Unified `agent.system` prompt (rewritten, new version)
- New internal-tool prompt `tool.synthesize_insights.v1`
- Deletion of `POST /api/deep_research`, removal of `mode` param on `ChatAgent`, deactivation of the `agent.deep_research_mode.v1` layered prompt (row kept, `active=false`)
- Streamlit chat page: removal of mode toggle, addition of a minimal fenced-chart renderer and a per-call Hypothesis badge
- Docker Compose entry for `mcp-tabicl` on port 8003
- Unit + integration tests; smoke-test addition

**Explicitly out of scope:**
- Proactive v1 (new experiment → autonomous trigger → `notifications` inbox) — Phase 5 Sub-project B, next brainstorm
- `mcp-chemprop` — deferred; TabICL covers the tabular ML need for this phase
- Hypothesis browsing / editing / status transitions UI — Phase 6 (correction workflow)
- GEPA prompt evolution — Phase 7
- Cross-portfolio admin review for `scope_nce_project_id IS NULL` hypotheses — Phase 8 RBAC hardening

## 3. Data model

### 3.1 Canonical tables (`db/init/03_hypotheses.sql`)

```sql
CREATE TABLE hypotheses (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hypothesis_text           text NOT NULL
        CHECK (length(hypothesis_text) BETWEEN 10 AND 4000),
    confidence                numeric(4,3) NOT NULL
        CHECK (confidence BETWEEN 0.0 AND 1.0),
    confidence_tier           text GENERATED ALWAYS AS (
        CASE WHEN confidence >= 0.85 THEN 'high'
             WHEN confidence >= 0.60 THEN 'medium'
             ELSE                          'low'
        END
    ) STORED,
    scope_nce_project_id      uuid REFERENCES nce_projects(id),  -- NULL => cross-portfolio
    proposed_by_user_entra_id text NOT NULL,
    agent_trace_id            text,  -- Langfuse trace ID, for reproducibility
    status                    text NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed','confirmed','refuted','archived')),
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hypothesis_citations (
    hypothesis_id uuid NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
    fact_id       uuid NOT NULL,  -- uuidv5 from kg-experiments; not an FK (facts live in Neo4j)
    citation_note text CHECK (length(citation_note) <= 500),
    PRIMARY KEY (hypothesis_id, fact_id)
);

CREATE INDEX idx_hypotheses_scope    ON hypotheses(scope_nce_project_id) WHERE status = 'proposed';
CREATE INDEX idx_hypotheses_user     ON hypotheses(proposed_by_user_entra_id);
CREATE INDEX idx_hypotheses_created  ON hypotheses(created_at DESC);

ALTER TABLE hypotheses ENABLE ROW LEVEL SECURITY;

-- A user sees a hypothesis if:
--   (a) they proposed it, OR
--   (b) it is scoped to a project they can access (via user_project_access).
-- Cross-portfolio hypotheses (scope IS NULL) are visible only to proposer
-- until the Phase 6 admin workflow lands.
CREATE POLICY hypotheses_owner_or_scope ON hypotheses FOR SELECT
USING (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
    OR EXISTS (
        SELECT 1 FROM user_project_access upa
        WHERE upa.nce_project_id = hypotheses.scope_nce_project_id
          AND upa.user_entra_id  = current_setting('app.current_user_entra_id', true)
    )
);
CREATE POLICY hypotheses_owner_insert ON hypotheses FOR INSERT
WITH CHECK (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
);

ALTER TABLE hypothesis_citations ENABLE ROW LEVEL SECURITY;
CREATE POLICY hypothesis_citations_via_parent ON hypothesis_citations FOR ALL
USING (
    EXISTS (SELECT 1 FROM hypotheses h WHERE h.id = hypothesis_citations.hypothesis_id)
);
```

`chemclaw_service` is `BYPASSRLS` and is the role the ingestion/projector workers use; user-facing code continues to go through `withUserContext(...)`.

### 3.2 Event flow

Insertion of a `hypotheses` row inside the `propose_hypothesis` tool is followed by an insert into `ingestion_events` with `event_type = 'hypothesis_proposed'` and payload `{"hypothesis_id": "<uuid>"}`. The existing `notify_ingestion_event` trigger fires `NOTIFY ingestion_events`. The `kg-hypotheses` projector subscribes.

Status transitions (`confirmed`, `refuted`, `archived`) emit `hypothesis_status_changed` events — consumer handler is stubbed in this phase and finalized in Phase 6.

### 3.3 Neo4j projection

- Node `:Hypothesis { fact_id, text, confidence, confidence_tier, scope_internal_id, created_at, valid_from }` — one per hypothesis.
- Edge `(:Hypothesis)-[:CITES { fact_id, note }]->(:Fact)` — one per citation.
- Uniqueness constraint on `fact_id` (already in place for Fact nodes) — MERGE is race-safe.
- `fact_id` for Hypothesis node: `uuid5(NAMESPACE_HYPOTHESIS, hypothesis_id)`.
- `fact_id` for CITES edge: `uuid5(NAMESPACE_CITES, hypothesis_id || '|' || fact_id)`.
- If the cited Fact node is missing in Neo4j, create an `ungrounded-<hash>` placeholder — same fallback pattern `kg-experiments` uses for ungrounded compounds. Warn, do not crash.

### 3.4 Featurizer feature schema

Shared between `statistical_analyze` and any future model-training path. Lives in `services/mcp_tools/mcp_tabicl/featurizer.py`.

| Column family | Source | Encoding |
|---|---|---|
| `drfp_pc_{1..32}` | 2048-bit DRFP → 32 PCA components | float |
| `rxno_class` | `reactions.rxno_class` | categorical |
| `solvent_class` | `experiments.solvent` → fixed 20-class lookup | categorical |
| `temp_c` | `experiments.temperature_c` | float |
| `time_min` | `experiments.time_min` | float |
| `catalyst_loading_mol_pct` | `experiments.conditions_json.catalyst_loading_mol_pct` | float (nullable) |
| `base_class` | fixed lookup | categorical |
| target | `experiments.yield_pct` | float (regression) |

DRFP PCA is fit once over all historical reactions and persisted to `/var/cache/mcp-tabicl/drfp_pca.json`. Persistence format is **plain JSON** (not pickle/joblib): PCA's learned state is three numpy arrays (`components_`, `mean_`, `explained_variance_`) plus `n_components`; all serialize cleanly via `.tolist()`. Loader reconstructs the arrays with `numpy.asarray(dtype=float64)` and applies the transform manually (`(X - mean_) @ components_.T`), so no scikit-learn pickle machinery is loaded at inference time and no arbitrary-code-execution surface exists. Missing cache → `/readyz` returns 503; refit is triggered by `make db.init.tabicl-pca`. Refit is an explicit admin action, never lazy inside a request.

## 4. `mcp-tabicl` service

### 4.1 Layout (`services/mcp_tools/mcp_tabicl/`)

```
__init__.py
main.py           # FastAPI via services.mcp_tools.common.app.create_app()
featurizer.py     # reaction rows → feature matrix + targets
pca.py            # DRFP → 32-dim PCA fit + JSON persist + load + transform
inference.py      # tabicl.TabICLRegressor / TabICLClassifier wrappers
requirements.txt
Dockerfile        # UID 1001, OpenShift-safe
```

### 4.2 Endpoints

| Method & Path | Purpose |
|---|---|
| `GET /healthz` | Liveness (from common). |
| `GET /readyz`  | 503 while PCA JSON artifact is missing; 200 otherwise. |
| `POST /featurize` | `{reaction_rows: [...], include_targets: bool}` → `{feature_names, rows: [[...]], targets: [...], skipped: [{reaction_id, reason}]}`. Applies canonicalization (`rdkit`), DRFP + PCA, categorical normalization. Max 1000 rows / call. Invalid SMILES → skipped (not fatal). |
| `POST /predict_and_rank` | `{support_rows, support_targets, query_rows, feature_names, task: "regression"|"classification", return_feature_importance: bool}` → `{predictions, prediction_std, feature_importance?}`. Fits TabICL in-context on support; predicts on query; optionally returns permutation-based feature importance. |
| `POST /pca_refit` | Admin-only (internal-auth header). Refits DRFP PCA on supplied reaction set; atomic swap of JSON artifact via temp-file + rename. |

### 4.3 Security + correctness

- Pydantic validates every field. SMILES length bound at 20_000 (matches `mcp-drfp`). `rxno_class` / `solvent` / `base` bounded at 200 chars.
- Row count per call ≤ 1000 (TabICL's realistic regime); `ValueError → 400` on overrun.
- **No pickle, no joblib, no arbitrary-code-execution surface in the PCA loader.** The cache file is JSON; schema-validated with Pydantic before any numeric use; shape-checked against the hardcoded `N_COMPONENTS = 32` and `N_FEATURES = 2048`. A mismatched shape refuses boot.
- `security_opt: [no-new-privileges:true]` in compose, read-only filesystem except for the cache volume.
- No regex inputs → no `safe-regex` concern.

### 4.4 Docker Compose

- Service name `mcp-tabicl` on port 8003.
- Healthcheck: `curl -sf http://localhost:8003/readyz`.
- Volume: `mcp-tabicl-cache:/var/cache/mcp-tabicl`.
- Depends on nothing at runtime (projectors don't need it; only the agent does).

## 5. New agent tools

All four live in `services/agent/src/tools/`, registered in `services/agent/src/agent/tools.ts`, with Zod input/output schemas and deps-injected execution — mirroring the existing `find_similar_reactions` pattern.

### 5.1 `expand_reaction_context`

```
Input:
  { reaction_id: uuid,
    include: Array<"reagents"|"conditions"|"outcomes"|"failures"|"citations"|"predecessors"> (default all),
    hop_limit: 1 | 2 (default 1) }
Output:
  { reaction,
    reagents?, conditions?, outcomes?,
    failures?,   // from mcp-kg (KG has :FailureMode nodes on Fact graph)
    citations?,  // via search_knowledge on reaction-adjacent text
    predecessors?  // 2-hop: synthetic_steps order; bounded at 5
  }
```

Data path: one SQL read inside `withUserContext` (reaction + `reagents_used` + `experiments` + `nce_projects` joins). Failures + citations fan out via `mcp-kg` / `search_knowledge`. Predecessors only when `hop_limit=2`. Bounded: 1 reaction, ≤6 KG queries, ≤1 search call.

### 5.2 `statistical_analyze`

```
Input:
  { reaction_ids: uuid[]  (min 5, max 500),
    question: "predict_yield_for_similar" | "rank_feature_importance" | "compare_conditions",
    query_reaction_ids?: uuid[]  (only for predict_yield_for_similar; disjoint from reaction_ids) }
Output:
  { task: "regression",
    support_size,
    predictions?,            // for predict_yield_for_similar
    feature_importance?,     // for rank_feature_importance
    condition_comparison?,   // for compare_conditions; bucketed SQL aggregation, no ML
    caveats: string[] }
```

Execution:
1. RLS-scoped SELECT of `reaction_ids` rows with featurizable columns.
2. `POST /featurize` on `mcp-tabicl`.
3. Branch by `question`:
   - `predict_yield_for_similar`: featurize query rows; `POST /predict_and_rank` with regression.
   - `rank_feature_importance`: `POST /predict_and_rank` with `return_feature_importance=true`; 80/20 split inside the service.
   - `compare_conditions`: SQL only — bucket by `solvent_class × temperature_bucket`, return `n/mean/median/p25/p75` of yield. No TabICL call.
4. Caveats compiled from `featurizer.skipped` + imputation counts.

### 5.3 `synthesize_insights`

```
Input:
  { reaction_set: uuid[]  (min 3, max 500),
    question: string  (20..2000 chars),
    prior_stats?: object }  // raw output of statistical_analyze, optional
Output:
  { insights: [
      { claim,
        evidence_fact_ids,
        evidence_reaction_ids,
        support_strength: "strong"|"moderate"|"weak",
        caveats? }
    ],
    summary }
```

Pure LiteLLM call via registry prompt `tool.synthesize_insights.v1`. Internally fetches `expand_reaction_context` per reaction_id in bounded-parallel (max 20 concurrent), feeds `{reactions, prior_stats, question}` into the prompt, parses the structured JSON output via Zod. Never writes to DB — it is a reasoning helper.

Hallucination guard: post-parse filter drops any `fact_id` / `reaction_id` not present in the expanded-context set. If all of an insight's evidence drops, the insight is removed and the agent is told (via tool result) to regenerate.

### 5.4 `propose_hypothesis` (non-terminal)

```
Input:
  { hypothesis_text: string  (10..4000),
    cited_fact_ids: uuid[]   (min 1, max 50),
    cited_reaction_ids?: uuid[]  (max 100),
    confidence: number  (0..1),
    scope_nce_project_id?: uuid,
    citation_notes?: { [fact_id]: string } }
Output:
  { hypothesis_id: uuid,
    confidence_tier: "low"|"medium"|"high",
    persisted_at: timestamp,
    projection_status: "pending" }
```

Single `withUserContext` transaction:
1. INSERT into `hypotheses`.
2. INSERT each citation into `hypothesis_citations`.
3. INSERT into `ingestion_events` with `event_type='hypothesis_proposed'` and payload `{hypothesis_id}`. The trigger fires NOTIFY; the projector wakes.

Returns immediately with the hypothesis_id and `projection_status: "pending"`. Non-terminal — Mastra's `maxSteps` still applies, and the agent can call `propose_hypothesis` multiple times per turn, or continue reasoning after.

`cited_fact_ids` validation — the primary anti-fabrication guard — works as follows. `ChatAgent` is instantiated per request and carries a **per-turn in-memory set `seenFactIds: Set<string>`**. Every tool that surfaces fact_ids (`find_similar_reactions`, `expand_reaction_context`, `query_kg`, `check_contradictions`, `search_knowledge`, `synthesize_insights`) appends its returned fact_ids into that set before the tool result is handed back to the model. `propose_hypothesis` rejects with HTTP 400 if any `cited_fact_ids` entry is not in `seenFactIds`. The set is discarded when the turn ends. No persistence, no cross-turn carryover.

### 5.5 Tool registration

`services/agent/src/agent/tools.ts` loses mode-keyed branching. **One tool catalog, all tools always available:**

```
search_knowledge, fetch_full_document, canonicalize_smiles,
find_similar_reactions, query_kg, check_contradictions,
draft_section, mark_research_done,
expand_reaction_context, statistical_analyze, synthesize_insights, propose_hypothesis
```

The agent picks which to call per request. The system prompt provides selection guidance.

## 6. Unified agent — removal of `mode` + dedicated routes

### 6.1 `ChatAgent` changes (`services/agent/src/agent/chat-agent.ts`)

- Remove the `mode: "default" | "deep_research"` parameter from the constructor/options.
- Remove mode-keyed prompt layering.
- Remove mode-keyed `maxSteps`; introduce a single constant `AGENT_MAX_STEPS = 40` in `config.ts` (matches the deepest cap DR had).
- Remove mode-keyed tool selection; agent gets the single catalog from §5.5.
- System prompt is always the active `agent.system` row (the rewritten one).

### 6.2 Routes

- **Delete** `services/agent/src/routes/deep_research.ts` and its registration in `index.ts`.
- `POST /api/chat` is the sole agent entry point. Existing SSE wire format, existing history + per-message caps, existing terminal-event guarantee.
- Rate limit: keep the existing default chat limit — no halved / quartered variants. The agent self-regulates how many tool calls it makes per turn; one cap is enough.

### 6.3 Prompt registry changes (`db/seed/04_unified_system_prompt.sql`)

Two operations in one idempotent seed file, inside a single transaction:

1. UPDATE the row with `name='agent.deep_research_mode.v1'` → `active = false`. Row is preserved for history; it is simply no longer selected by the registry.
2. INSERT new `agent.system` row at `version=2`, `active=true`. The existing `v1` row is set `active=false` in the same transaction.

The unified prompt body (full text outlined in §6.5) teaches the agent the whole tool catalog, when to reach for which tool, and response-form guidance. `tool.draft_section.v1` / `tool.mark_research_done.v1` / `tool.synthesize_insights.v1` remain as-is — these are *internal* tool prompts, not modes.

### 6.4 Chart rendering contract

The agent may emit a fenced `chart` block in its assistant messages when a visualization is more useful than prose. The minimal format (chosen for MVP simplicity — Streamlit's built-in chart primitives render it without an extra dep):

````
```chart
{"type": "bar" | "line" | "scatter",
 "title": "...",
 "x_label": "...", "y_label": "...",
 "x": [ ... ], "y": [ ... ]  |  "series": [{"name": "...", "y": [...]}, ...]}
```
````

Frontend parses the block, validates with a strict Pydantic schema (bounded array lengths, bounded strings, no nested objects beyond the series structure above), routes to `st.bar_chart` / `st.line_chart` / `st.scatter_chart`. Unknown `type` or malformed JSON → fall back to rendering the fenced block as plain code. No `eval`, no HTML injection path.

### 6.5 Unified system prompt content (high-level outline)

- Who the agent is: an autonomous knowledge-intelligence agent for pharma chem/analytical development.
- Full tool catalog, one-sentence description each.
- Selection heuristics ("to answer a retrieval question start with `search_knowledge`…", "for cross-project patterns start with `find_similar_reactions` + `expand_reaction_context` + `statistical_analyze`…", "for multi-section answers use `draft_section` and optionally `mark_research_done` to persist a report…", "when evidence supports a generalizable claim, `propose_hypothesis` with ≥3 cited fact_ids…").
- Citation discipline: always cite `fact_id`s verbatim from tool outputs. Never fabricate.
- Confidence calibration: use the confidence field honestly; low is fine, padding isn't.
- Response-form guidance: use tables for multi-row comparisons, fenced `chart` blocks when a chart is clearer than prose, single-sentence answers for single-sentence questions, markdown sections for long answers.
- Termination: `mark_research_done` is one of several ways to end a turn, not the only way. A well-answered simple question ends with an assistant message — no mandatory terminal tool.

The full prompt body is authored during implementation; committed as the seed's literal string. ~1–1.5k tokens.

## 7. `kg-hypotheses` projector

Location: `services/projectors/kg_hypotheses/` — standard `BaseProjector` subclass, sibling of `kg_experiments`.

```
name                      = "kg-hypotheses"
interested_event_types    = ("hypothesis_proposed", "hypothesis_status_changed")
```

### 7.1 Handler — `hypothesis_proposed`

1. Fetch canonical hypothesis row + citations from Postgres by `hypothesis_id` (BYPASSRLS service role).
2. Compute node `fact_id = uuid5(NAMESPACE_HYPOTHESIS, hypothesis_id)`.
3. `graphiti.add_node(labels=["Hypothesis"], props={fact_id, text, confidence, confidence_tier, scope_internal_id, created_at, valid_from=created_at})`. MERGE on `fact_id` (existing uniqueness constraint).
4. For each citation: `graphiti.add_edge(CITES, hypothesis_node, fact_node, props={note}, fact_id=uuid5(NAMESPACE_CITES, hypothesis_id || '|' || fact_id))`. If target Fact is absent: create `ungrounded-<hash>` placeholder node and link to it (matching `kg-experiments` pattern); warn.
5. Ack.

### 7.2 Handler — `hypothesis_status_changed` (stub for Phase 6 compat)

1. Fetch current status.
2. `refuted` → Graphiti temporal invalidation (`valid_to = now()`).
3. `archived` → add property `archived=true`.
4. Ack.

### 7.3 Idempotency

- MERGE on `fact_id` (node + edge) — re-running the same event is a no-op.
- Partial-failure recovery: crash between node and edges is fine — replay fills in the missing edges.
- Full replay: `DELETE FROM projection_acks WHERE projector_name='kg-hypotheses'` → rebuilds from event log.

### 7.4 Startup behavior

Inherited from `BaseProjector`: on boot, pull unacked events of the subscribed types and process before entering LISTEN/NOTIFY.

## 8. Frontend changes (`services/frontend/pages/chat.py`)

- **Remove** the mode selector entirely — no `st.radio`, no session state for mode.
- The page posts every turn to `/api/chat`; one endpoint.
- Tool-call panels: unchanged — they render any registered tool's name/input/output. New tools get rendering for free.
- When the rendered turn contains a `propose_hypothesis` tool call, show a small inline badge `Hypothesis <ID short> · conf=0.xx · tier=<tier>` above the tool panel. No new page.
- Fenced-chart renderer: parse assistant messages, detect ` ```chart ... ``` ` blocks, validate with Pydantic, route to `st.bar_chart` / `st.line_chart` / `st.scatter_chart`. Invalid blocks render as code (safe fallback).
- No viewer / inbox / list for hypotheses in this phase — that's Phase 6.

## 9. Migration plan

1. New schema file (`03_hypotheses.sql`) + seed file (`04_unified_system_prompt.sql`) apply idempotently via `make db.init`.
2. `ChatAgent` refactor + route deletion ship together in the same commit — no partial state where Streamlit points to a deleted endpoint.
3. `prompt_registry` transitions in one transaction: `agent.system` v1 → v2 active flip, `agent.deep_research_mode.v1` → inactive. `PromptRegistry` cache TTL of 60s means a running agent picks up the new prompt within a minute; long-running processes call `invalidate()` on deploy (no change — existing behavior).
4. Existing tests that assert mode branching are deleted (not ported) — mode is gone.
5. Documentation: update `CLAUDE.md` "Status" section once Phase 5A lands. Phase 4 line updated to note mode was unwound. No separate migration doc.

## 10. Testing strategy

### 10.1 Python — `tests/unit/` and `tests/integration/`

- `test_hypotheses_schema.py` — CHECK constraints, generated column, RLS policy (user A can't read user B's cross-portfolio row), cascade on deletion.
- `test_featurizer.py` — DRFP→PCA round-trip stability, categorical normalization, NaN handling, row-cap rejection, `skipped` payload.
- `test_mcp_tabicl.py` — `/featurize` + `/predict_and_rank` on synthetic dataset (deterministic seed); `/readyz=503` when PCA artifact missing; row-cap rejection; PCA JSON shape mismatch refuses boot; malformed PCA JSON refuses boot.
- `test_kg_hypotheses_projector.py` (gated Neo4j integration) — proposed event → node + CITES edges; replay idempotency; ungrounded-fact fallback; status-change handler stub doesn't crash.

### 10.2 TypeScript — `services/agent/tests/`

- `expand-reaction-context.test.ts` — per-`include` flag behavior, RLS blocks cross-project reads, `hop_limit=2` bounded.
- `statistical-analyze.test.ts` — three question branches, mocked `mcp-tabicl`, imputation-caveat emission, RLS-filtered input.
- `synthesize-insights.test.ts` — LiteLLM mocked with canned structured output, Zod parse, hallucination filter drops non-input fact_ids.
- `propose-hypothesis.test.ts` — canonical INSERT + citations + event emission; returns pending status; `cited_fact_ids` containing a UUID not in the turn's `seenFactIds` → 400; happy path when all cited ids are in `seenFactIds`.
- `chat-route.test.ts` — update existing tests for mode removal; new tests assert unified behavior (one endpoint, no mode param).
- `chat-agent.unified.test.ts` — unified prompt loaded, full tool catalog registered, `maxSteps=40`; deep-research-style question drives the agent to use DR tools; cross-learning-style question drives it to use cross-learning tools; simple greeting terminates well under `maxSteps` with no tool calls; `seenFactIds` set resets between turns.
- `deep-research.route.deletion.test.ts` — `POST /api/deep_research` returns 404.

### 10.3 Counts

Target: **~15–17 new tests** plus removal of mode-branch tests.
Python: 110 → ~122–124. TypeScript: 68 → ~78–80. Type-check stays green.

### 10.4 Smoke test

`scripts/smoke.sh` gains:
- `curl -N /api/chat` with a pre-seeded cross-project question, asserts SSE terminates and at least one `hypotheses` row appears for the seeded user within 60s (projector fires).
- `curl -sf /api/deep_research` asserts 404 (confirms the deletion landed).

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| TabICL v2 API drift after pin | Pin exact minor in `requirements.txt`; synthetic-dataset test fails on API change; CI catches before prod. |
| First-request PCA cold-fit times out | Cold-fit is an explicit admin target (`make db.init.tabicl-pca`); `/readyz` blocks traffic until artifact exists; agent retries on 503. |
| Agent proposes many low-confidence hypotheses that pollute KG | `agent.system` v2 gates low-confidence proposals in the prompt; `confidence ≤ 0.3` logged as warning; Phase 6 correction workflow will enable bulk archival. |
| Hypothesis cites a Fact the user can't see | `propose_hypothesis` validates `cited_fact_ids` against the in-turn expanded-context cache; unknown IDs → 400 with a clear message so the agent re-plans. |
| LLM fabricates fact_ids in `synthesize_insights` output | Zod requires uuid format; post-parse filter drops non-input ids; agent re-loops if all evidence filtered. |
| Removing mode breaks an integration elsewhere | Grep-audit for `mode:`, `/api/deep_research`, `deep_research_mode` before landing; only caller in the repo today is the Streamlit chat page. |
| DRFP PCA 32 dims too narrow for feature importance to be crisp | Dimensionality lives in one constant; bump requires refit. `/pca_refit` admin endpoint exists for this exact case. |
| Chart-spec rendering trusts agent-generated JSON | Strict Pydantic schema with bounded array lengths; malformed or unknown-type blocks render as code; no HTML, no script execution. |
| Unified prompt grows unwieldy as Phase 6/7/8 add behaviors | Sections are clearly labeled; GEPA evolution in Phase 7 will trim; not a blocker now. |
