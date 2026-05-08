# Ab-initio / chemistry tools deep review

Date: 2026-05-08
Branch: `claude/review-ab-tools-1lW5K`
Scope: every chemistry / scientific MCP tool the agent can call, plus the harness paths
       that expose them, the persistence pipeline downstream of their results, and the
       storage-correctness controls (RLS / audit / redaction / validation) that gate them.

Three questions framed by the user:

1. Deep review of the "ab-initio" tools currently shipping.
2. Can the agent **freely** compose them into individual, use-case-specific workflows?
3. Is the data they produce **stored correctly**?

Short answers up front, detail below.

| Question | Answer |
|---|---|
| 1. What "ab initio" tools exist? | None, strictly. xtb / CREST are **semi-empirical** (GFN2-xTB / GFN-FF). The rest are ML retrosynthesis (askcos, aizynth), ML property/yield (chemprop), MS-fingerprint ID (sirius), LLM-guided mechanism search (synthegy-mech), or pure cheminformatics (rdkit, drfp). |
| 2. Free workflow composition? | **Yes, but only inside the active turn.** The LLM has full freedom to mix tools in any order; nothing pre-bakes a recipe. But every composition mechanism that would let the agent run a long, branching, multi-day workflow has a sharp limitation. |
| 3. Stored correctly? | **Partially.** What does land in Postgres is RLS-tight, JWT-auth'd, validated, and bi-temporal-ready. The much bigger problem is that almost nothing lands at all — most chemistry results are ephemeral. |

---

## 1. What's actually in the repo

### 1.1 Naming: "ab initio" is a stretch

The user's phrase "ab initio tools" does not match the repo. There is no Hartree-Fock,
DFT, MP2, coupled-cluster, Psi4, ORCA, or PySCF anywhere. The closest thing is xtb,
which is **semi-empirical tight-binding** (GFN2-xTB and GFN-FF). For the rest of this
document I treat the user's request as covering the full chemistry/scientific MCP suite,
not just QM.

### 1.2 Tool map

| Service (port, profile) | Class | What it does | Persists state? |
|---|---|---|---|
| `mcp-xtb` (8010, chemistry) | Semi-empirical QM | single-point, geometry opt, frequencies, transition state, IRC, scans, MD, metadynamics, pKa, NCI, NMR, excited states, Fukui, charges, redox, `run_workflow` (2 named recipes) | **Yes** — `qm_jobs`, `qm_results`, `qm_conformers`, `qm_frequencies`, `qm_thermo`, `qm_scan_points`, `qm_irc_points`, `qm_md_frames` (`db/init/23_qm_results.sql`) |
| `mcp-crest` (8014, chemistry) | Semi-empirical QM | conformer / tautomer / protomer ensembles | **Yes** — same `qm_jobs` / `qm_conformers` cache |
| `mcp-askcos` (8007, chemistry) | ML retrosynthesis | `/retrosynthesis`, `/forward_prediction`, `/recommend_conditions` | No |
| `mcp-aizynth` (8008, chemistry) | ML retrosynthesis | `/retrosynthesis` (tree search) | No |
| `mcp-chemprop` (8009, chemistry) | ML MPNN | `/predict_yield`, `/predict_property` (logP/logS/mp/bp + std) | No |
| `mcp-sirius` (8012, chemistry) | MS structural ID | `/identify` (CSI:FingerID + CANOPUS) | No |
| `mcp-synthegy-mech` (8011, chemistry) | LLM-guided A* | mechanism elucidation via arrow-pushing primitives (Bran et al. 2026) | No |
| `mcp-rdkit` (8001) | Cheminformatics | canonicalize, InChIKey, fingerprints, descriptors, substructure | No |
| `mcp-drfp` (8002) | Cheminformatics | reaction fingerprints | No |
| `mcp-doc-fetcher` (8006, full) | I/O | PDF / HTTP / file fetch with text extract | tmp only |
| `mcp-eln-local` (8013, testbed) | Read-only ELN adapter | `mock_eln` schema queries | reads only, dedicated read-only role |
| `mcp-logs-sciy` (8016, sources) | Read-only SDMS adapter | LOGS/SciY backend (fake-postgres or real) | reads only |

Half-finished surfaces (return `501`):
- `mcp-xtb`: `/transition_state`, `/irc` if external GSM not available; `/nmr_shieldings` if the xtb build lacks it; `method='g-xTB'` (`007bc5a` — was silently falling back to GFN2 under a `--general` placeholder; standalone `gxtb` binary not yet wired into the Dockerfile).
- `mcp-doc-fetcher`: `s3://`, `smb://`, `sharepoint://` schemes are stubs.
- `mcp-synthegy-mech`: server-side wall-clock 270 s; ionic surface only — radical/pericyclic emit a `warnings` entry.

### 1.3 Provenance and uncertainty per tool

| Tool | Uncertainty in response | Model version stamp |
|---|---|---|
| chemprop | `std` per prediction (aleatoric) | hardcoded `model_id` (`yield_model@v1`, etc.) |
| askcos | route score only; not calibrated | hardcoded `askcos_condition_recommender@v2` |
| aizynth | tree score; not calibrated | none |
| xtb / crest | `converged` + `gnorm`; no error bars on energy | method enum stored (GFN2 / GFN-FF), no version |
| sirius | per-candidate score; ClassyFire class with no calibration | none |
| rdkit / drfp | n/a (deterministic) | none |

Implication: when the agent asserts `confidence_tier: FOUNDATION` based on a chemistry
prediction, only chemprop carries calibrated uncertainty. The others are heuristic. The
foundation-citation guard does not currently know this — see §3.5.

---

## 2. Can the agent freely compose use-case-specific workflows?

### 2.1 Inside a single turn / chained run — yes

The harness gives the LLM a flat tool catalog. Every chemistry builtin in
`services/agent-claw/src/tools/builtins/` (`propose_retrosynthesis`,
`qm_single_point`, `qm_geometry_opt`, `qm_frequencies`, `qm_fukui`, `qm_redox_potential`,
`qm_crest_screen`, `predict_molecular_property`, `predict_reaction_yield`,
`predict_yield_with_uq`, `identify_unknown_from_ms`, `run_xtb_workflow`,
`canonicalize_smiles`, …) is registered unconditionally in
`services/agent-claw/src/bootstrap/dependencies.ts:188-297`, marked `readOnly: true`,
and has no preset successor / predecessor. There are **no macro / composite tools** —
no `propose_synthesis_and_validate`, no `qm_screening_pipeline`. Composition is pure
ReAct.

Skill packs (`skills/askcos_route/`, `skills/qm_pipeline_planner/`,
`skills/synthegy_feasibility/`, `skills/aizynth_route/`, `skills/retro/`,
`skills/chemprop_yield/`, `skills/xtb_conformer/`, `skills/closed-loop-optimization/`,
~20 packs total) are **advisory text** consumed by the `apply-skills` `pre_turn` hook;
they do not enforce sequence or gate combinations. When ≥1 skill is active, the catalog
is filtered to the union of their declared tools plus `ALWAYS_ON_TOOLS` — a permissive
intersection, not a state machine.

`run_xtb_workflow` is the one mild constraint — it exposes only two server-side recipes
(`optimize_ensemble`, `reaction_energy`). To run a custom xtb pipeline the agent must
call the individual QM tools sequentially.

### 2.2 Across a long multi-step run — partial

`services/agent-claw/src/core/chained-harness.ts` runs a bounded loop until
`finishReason ∈ {stop, awaiting_user_input, max_steps, session_budget_exceeded}`. On
`max_steps` it injects a synthetic "Continue from last step" message and re-enters; on
`session_budget_exceeded` / `budget_exceeded` it aborts. So a workflow of
"aizynth → xtb on N intermediates → chemprop on each product → store" can survive
several turns, but the per-session token budget can cut it mid-route with no graceful
degradation. The session reanimator
(`services/optimizer/session_reanimator/`) auto-resumes stalled `in_progress` todos
every 5 min, capped at `agent_sessions.auto_resume_cap` (default 10), and is not
chemistry-aware.

### 2.3 Sub-agents — blocked for chemistry

`services/agent-claw/src/core/sub-agent.ts:36-55` declares three subset profiles:

```
chemist:  find_similar_reactions, expand_reaction_context, statistical_analyze,
          canonicalize_smiles, query_kg
analyst:  analyze_csv, search_knowledge, query_kg, check_contradictions
reader:   search_knowledge, fetch_full_document, fetch_original_document
```

None of `propose_retrosynthesis`, `qm_*`, `predict_*`, `identify_unknown_from_ms`,
`enqueue_batch`, `workflow_*`, or the synthegy-mech wrapper are in any sub-agent
profile. Sub-agents are retrieval/reasoning only. The agent **cannot** spawn a
sub-agent to "evaluate the feasibility of these 50 candidates with QM and yield
prediction in parallel" — the parent has to do it serially in its own loop.

### 2.4 Plan mode — accept/reject only

`services/agent-claw/src/core/plan-mode.ts` + `routes/chat-plan-mode.ts` stream
`plan_step` SSE events for previewed tool calls. `POST /api/chat/plan/approve`
runs the plan via `runHarness`. The plan is **immutable after generation** — the user
cannot edit `method='GFN2'` → `'GFN-FF'`, change a SMILES, reorder steps, or add a
conditional branch. They can only accept or discard.

### 2.5 manage_todos — generic text

`tools/builtins/manage_todos.ts` accepts `contents: string[]`. The `agent_todos`
schema is `id, ordering, content, status, created_at, updated_at`. There are no
chemistry fields (smiles, job_id, method, intermediate_id), so a multi-step QM workflow
has to be encoded as plain English. Reanimator and chained-harness see todos as opaque
strings.

### 2.6 workflow_engine — deterministic batch runner, not agent-authored

`services/workflow_engine/main.py` reacts to `pg_notify('workflow_event', run_id:seq)`
events and dispatches the next runnable step. Step kinds: `tool_call`, `conditional`
(JMESPath), `wait`, `parallel`, `sub_agent` are wired (`b4ed668`); `loop` still raises
`NotImplementedError` because each iteration needs its own
`step_started` / `step_succeeded` events and that bookkeeping deserves a separate change.
The agent reaches it via the `workflow_define` / `enqueue_batch` / `inspect_batch`
builtins — useful for ≥3-candidate QM screens (see `qm_pipeline_planner` skill), but the
agent is **not the orchestrator**: it defines the DAG up front and the engine fans out.
Iterative refinement (loop until converged) is currently impossible at the engine level.

### 2.7 Forged tools — generic schema

`forge_tool` (Phase D.5) lets the agent author a Python tool, sandbox-test it, and
persist to `skill_library` (`maturity=EXPLORATORY`, `shadow_until=NOW()+14 days`). The
forge mechanism has no chemistry semantics — input schema is generic JSON, no SMILES
canonicalization at validation time, no domain-specific test fixtures. A forged tool
*can* call chemistry builtins internally, but the agent has to encode the
chemistry-specific input contract itself.

### 2.8 Cross-session memory — blocked

`agent_sessions.scratchpad` is per-session. The artifacts table (with `valid_from /
superseded_at` columns) can hold long-lived structured outputs but is only written for
the seven `ARTIFACT_TOOL_IDS` (none of them chemistry — see §3.4). When the user comes
back tomorrow and says "use the route we found yesterday for compound X", nothing in
the scratchpad surface or session-resume path automatically resurfaces yesterday's
route. The agent must explicitly `query_kg` / `search_knowledge` and reconstruct.

### 2.9 Permission and approval

Every chemistry builtin is `readOnly: true`. There is **no default permission policy**
gating any chemistry tool — `permission_policies` is admin-populated. An admin can add
`('org', 'ask', 'qm_*')` to require approval, but the seed contains nothing of the
kind. The aggregator default is allow.

### 2.10 Composition mechanism scorecard

| Mechanism | For chemistry workflows | Reason |
|---|---|---|
| flat tool catalog inside a turn | works | unconditional registration, ReAct freedom |
| skill packs as guidance | works | 20+ packs, advisory only |
| chained-harness auto-loop | works with budget caveat | aborts on session budget exceeded |
| ask_user pause/resume | works | round-trips through `agent_sessions.awaiting_question` |
| plan mode | partial | accept/reject only — no editing |
| manage_todos | partial | text-only, no chemistry-aware fields |
| sub-agents | **blocked** | chemistry tools not in any profile |
| workflow_engine | partial | `tool_call` / `conditional` / `wait` / `parallel` / `sub_agent` wired; `loop` still NotImplementedError |
| reanimator | partial | generic, capped at 10 auto-resumes |
| forged tools | partial | generic schema, no chemistry validation hooks |
| cross-session memory | **blocked** | chemistry results never become artifacts; no resurfacing |

---

## 3. Is data stored correctly?

The core finding: **most chemistry results are not stored at all**, and the small
slice that IS stored takes a side door around the canonical event-sourcing pipeline.
Storage-correctness controls on what does get persisted are good.

### 3.1 What lives, what dies

| Tool | Result lifetime |
|---|---|
| xtb single point / opt / freq / scan / MD / IRC / NCI | Postgres (qm_jobs row + typed result rows). Persistent, project-agnostic, cache-keyed. |
| crest conformer / tautomer / protomer | Postgres (qm_jobs + qm_conformers). Same cache. |
| askcos retrosynthesis / forward / conditions | **Lost at session end.** No DB write. |
| aizynth retrosynthesis | **Lost at session end.** |
| chemprop predict_yield / predict_property | **Lost at session end.** |
| sirius identify | **Lost at session end.** |
| synthegy-mech mechanism | **Lost at session end.** |
| rdkit / drfp utilities | n/a (pure compute, but DRFP vectors *do* land in `reactions.drfp_vector` for ELN-imported reactions via `reaction_vectorizer`) |

Anything that lands in the LLM's reasoning trace and not in Postgres is gone when the
session compacts or ends.

### 3.2 The source-cache hook does not match any chemistry tool

`services/agent-claw/src/core/hooks/source-cache.ts:36`:

```ts
const SOURCE_TOOL_PATTERN = /^(query_eln|fetch_eln|query_lims|fetch_lims|query_instrument|fetch_instrument)_/;
```

Every chemistry builtin is named `propose_retrosynthesis`, `qm_*`, `predict_*`,
`identify_unknown_from_ms`, `canonicalize_smiles`, … none of them match the regex.
The corresponding `kg_source_cache` projector consumes `source_fact_observed` events
that are never emitted for chemistry. So the hook + projector pair, despite being
the canonical "tool-call result → KG node" pipeline, has zero coverage of chemistry
results.

This is most likely intentional — the hook was scoped to source-system queries (ELN /
LIMS / instrument metadata), not compute results — but the consequence is that nothing
fills the void. There is no `compute_result_observed` event type; no chemistry-result
projector exists.

### 3.3 QM results take a custom NOTIFY side door

`db/init/23_qm_results.sql:177-189` defines a trigger that fires
`pg_notify('qm_job_succeeded', NEW.id::text)` on QM job completion.
`services/projectors/qm_kg/main.py:54` LISTENs on that channel directly with
`interested_event_types = ("qm_job_succeeded",)` — the same custom-channel pattern that
`compound_classifier` and `compound_fingerprinter` use (CLAUDE.md "Custom NOTIFY
channels (DR-06)").

Implications:
- QM results bypass `ingestion_events` and the `ingestion_event_catalog` vocabulary.
- Replay and provenance still work via `projection_acks` (BaseProjector handles
  this), but anyone auditing "what events caused this Neo4j node" must know to look
  in `qm_jobs` instead of `ingestion_events`.
- Re-derivation is a two-step:
  `DELETE FROM projection_acks WHERE projector_name='qm_kg'` AND restart, plus the
  `qm_jobs` rows must still exist. If a `qm_jobs` row is ever pruned, the KG node
  cannot be replayed.

This is acceptable but worth documenting in the runbook for full-rebuild scenarios.

### 3.4 Maturity tagging does not cover chemistry tools

`services/agent-claw/src/core/hooks/tag-maturity.ts:18-26`:

```ts
const ARTIFACT_TOOL_IDS = new Set<string>([
  "propose_hypothesis",
  "synthesize_insights",
  "draft_section",
  "mark_research_done",
  "dispatch_sub_agent",
  "check_contradictions",
  "compute_confidence_ensemble",
]);
```

Chemistry tool outputs get the in-memory `maturity: "EXPLORATORY"` stamp on the tool
result payload (line 32-45), but no artifacts row is written and the maturity is
discarded at turn end. Same for the foundation-citation guard
(`services/agent-claw/src/core/hooks/foundation-citation-guard.ts:29-94`), which only
inspects `ctx.scratchpad.artifactMaturity` — empty for chemistry results — so it cannot
catch the agent claiming `FOUNDATION` confidence on a heuristic askcos route.

### 3.5 Ingestion-event vocabulary has no chemistry types

`db/init/35_event_type_vocabulary.sql:38-95` defines:
`experiment_imported`, `document_ingested`, `hypothesis_proposed`,
`hypothesis_status_changed`, `source_fact_observed`, plus `qm_job_succeeded` (marked
"legacy custom NOTIFY"), and a reserved set (`reaction_corrected`, `fact_invalidated`,
`artifact_corrected`, `workflow_run_succeeded`).

Missing: `retrosynthesis_proposed`, `mechanism_predicted`, `molecular_property_predicted`,
`yield_predicted`. Without these, no projector can declare interest in chemistry-compute
results, and there is no canonical record of the prediction even if a future projector
wanted one.

### 3.6 No predicted-vs-experimental separation in `reactions`

`db/init/01_schema.sql:114-129` has a single `reactions` table whose `confidence_tier`
column is `expert_validated | multi_source_llm | single_source_llm | expert_disputed |
invalidated`. There is no `is_predicted` flag. If askcos / aizynth routes were ever
written to this table, they would mix with ELN-observed reactions and the `multi_source_llm`
tier would silently broaden to mean "ML retrosynthesis prediction or LLM extraction
from a paper". Today this is moot — askcos/aizynth output is never written — but
adding a chemistry-result write path without a discriminator field would be a data-model
regression.

### 3.7 Storage-correctness controls — strong on what does get persisted

The audit on what *is* stored came back clean:

- **RLS:** `reactions`, `compounds`, `compound_*`, `hypotheses`, `artifacts`,
  `synthetic_steps`, `compound_smarts_catalog`, `compound_substructure_hits`,
  `compound_classes`, `compound_class_assignments`, `mock_eln.*`, `fake_logs.*` all
  carry FORCE RLS with project-scoped predicates and authenticated policies
  (`db/init/12_security_hardening.sql`, `39_compound_catalog_rls.sql`,
  `49_*_force_rls.sql`).
- **Connection roles:** agent-claw connects as `chemclaw_app`
  (`services/agent-claw/src/db/pool.ts:20`); projectors as `chemclaw_service`. No
  user-driven path uses the `chemclaw` owner role.
- **MCP auth:** every chemistry MCP runs through `services/mcp_tools/common/app.py`
  bearer-token middleware with audience binding (`expected_audience=name`) and
  scope claims (`mcp_xtb:invoke`, `mcp_aizynth:invoke`, etc.). Healthchecks are
  the only exempt routes.
- **Input validation:** `services/mcp_tools/common/limits.py` defines
  `MAX_SMILES_LEN=10_000`, `MAX_RXN_SMILES_LEN=20_000`, `MAX_BATCH_SMILES=100`,
  `MAX_BATCH_RXN_SMILES=1000`. Every Pydantic model uses `Field(min_length=...,
  max_length=...)`. SMILES go through RDKit parse before any subprocess. Subprocess
  calls use explicit arg lists (no shell). Wave-2 cluster A07
  ("chemistry-tool input validation") is in.
- **Bi-temporal columns:** present on `reactions`, `hypotheses`, `artifacts`
  (`db/init/17_unified_confidence_and_temporal.sql`). Backfilled. Not yet *written*
  by chemistry-result paths because there are no chemistry-result paths.
- **Confidence ensemble:** `compute_confidence_ensemble` builtin scores artifacts
  with three signals (verbalized, cross-model, Bayesian). Only runs on artifacts;
  chemistry-tool numeric uncertainty (e.g. chemprop `std`) is not auto-fed in.
- **Forged-tool storage:** RLS, audit triggers, code SHA-256 integrity check on
  every call. Solid.
- **Redaction:** `tests/unit/test_redactor.py` covers SMILES tokens (length-bounded
  alphabet), reaction SMILES, NCE/CMP project codes, emails. The pre-egress
  LiteLLM callback runs on prompts; the `redact-secrets` `post_turn` hook runs on
  final agent text.

### 3.8 Audit and redaction gaps worth flagging

- **Audit triggers do not cover chemistry-derived rows.**
  `db/init/19_observability.sql:18` audits `nce_projects`, `synthetic_steps`,
  `experiments`, `agent_sessions`, `agent_plans`, `agent_todos`, `skill_library`,
  `forged_tool_tests`. Not `reactions`, `hypotheses`, `artifacts`. If a hypothesis
  is overwritten by re-running `propose_hypothesis`, the change is silent. Bigger
  problem once chemistry-result writes exist.
- **MCP responses are not redacted before entering the LLM context.**
  Outbound to LiteLLM is redacted; inbound from MCP services is not. If a chemistry
  service ever leaks tenant content (today they shouldn't, but `mcp-eln-local`
  reads tenant tables), that string is live in the LLM transcript until the
  `post_turn` hook scrubs the final answer. Intermediate reasoning over
  unredacted MCP data still reaches LiteLLM's request log.
- **Idempotency.** `tag-maturity.ts:107` and `propose_hypothesis.ts:67`
  INSERT without `ON CONFLICT`. Re-running a tool produces duplicate rows. Bi-temporal
  columns are ready to support `ON CONFLICT … DO UPDATE SET valid_to = NOW()` but
  the agent does not author such writes today.

---

## 4. Recommendations, ordered by leverage

These are recommendations, not commitments. Each is logged in `BACKLOG.md`.

1. **Decide the persistence policy for prediction tools.** The big question: should
   askcos / aizynth / chemprop / sirius / synthegy-mech results be canonical rows in
   the KG or stay ephemeral? Today they are ephemeral, which means every "use the
   route we found yesterday" prompt costs the agent a fresh round-trip. Options:
   (a) leave ephemeral, document loudly that compute results don't persist;
   (b) emit a `compute_result_observed` ingestion event per call and write a
   typed row to a new `predicted_reactions` / `predicted_properties` table with
   `is_predicted=true` and `model_id`; (c) add a generic
   `compute_result_observed` event + `compute_results` table keyed by
   `(tool_id, input_hash)` analogous to `qm_jobs`. (b) and (c) need a
   predicted-vs-experimental discriminator in `reactions` and the related tables
   (§3.6).
2. **Extend `ARTIFACT_TOOL_IDS` to chemistry tools, or add a chemistry-aware
   maturity tagger.** Without this the foundation-citation guard cannot catch
   the agent over-claiming on heuristic predictions. Easiest first step:
   wrap chemistry tool calls in an artifact when the agent commits to a
   prediction (e.g., `propose_retrosynthesis` → `artifact(kind='retro_route',
   maturity=EXPLORATORY, payload={routes,…})`).
3. **Unify QM-result persistence with the canonical event-sourcing pattern.**
   The `qm_job_succeeded` custom NOTIFY should either be promoted to a real
   `ingestion_event_catalog` entry with a clear payload contract, or the trigger
   should also write to `ingestion_events` for replay/audit consistency. Today's
   side door works but breaks the "event log is the source of truth" mental
   model.
4. **Lift sub-agent chemistry restriction or document why it stays.** The
   `chemist` profile gives sub-agents query-only tools. For "evaluate 50
   candidates" workloads this means parent serialization. Either add a
   `chemist_compute` profile that includes QM/ML predictors with a tighter
   token budget, or document the design rationale (cost? blast radius?
   confidence-tagging gap?) in `docs/adr/`.
5. **Make `manage_todos` chemistry-aware.** Adding a `metadata JSONB` column
   to `agent_todos` with a typed sub-schema (`{kind: 'qm_step', smiles, method,
   parent_job_id}`) lets the reanimator and chained-harness reason about
   workflow state without parsing free text.
6. **Edit-on-approve in plan mode.** Today the user can only accept/reject. Letting
   the user tweak `method` / `solvent` / `top_k` before approving turns plan mode
   from a preview into a co-pilot.
7. **Fill the audit-trigger gap** on `reactions`, `hypotheses`, `artifacts` once
   chemistry-result writes exist (§3.8).
8. **Redact MCP responses** before they enter the LLM context, not only on the
   way out. Adds defense-in-depth for tenant data flowing through `mcp-eln-local`
   and `mcp-logs-sciy`.
9. **Cross-session resurfacing.** When a session resumes, expose a
   "recent artifacts for this user/project" preamble in the scratchpad so the
   agent can reference yesterday's routes without an explicit KG query.
10. **Wire chemprop's `std` into `compute_confidence_ensemble`.** Calibrated
    aleatoric uncertainty is the one signal these tools actually provide; today
    it is discarded.

---

## 5. Methodology

This review was produced by five parallel Explore sub-agents covering: tool inventory,
agent-side tool-exposure surface, downstream persistence, workflow-composition
mechanisms, and storage-correctness controls. Findings were cross-checked against
`CLAUDE.md`, `docs/review/2026-05-05/08-chemistry-domain-audit.md`,
`docs/review/2026-05-05/13-data-layer-audit.md`, and the cited source files.

No code was modified.
