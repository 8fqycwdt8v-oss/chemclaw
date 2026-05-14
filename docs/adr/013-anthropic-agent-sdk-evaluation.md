# ADR 013 — Anthropic Agent SDK as Agent Backend: Fresh-Start Evaluation

**Status:** Informational — evaluation only, not adopted. The current
production agent stays on the custom harness (ADRs 004, 007, 008, 009,
010). This ADR records the answer to "if we were building ChemClaw fresh
today, would we keep the custom loop or use the Anthropic Agent SDK?" so
the question can be answered from this artifact next time instead of
re-derived.

**Date:** 2026-05-14

**Context:** ChemClaw harness alternatives review — branch
`claude/evaluate-anthropic-sdk-HACPP`.

---

## Context

ChemClaw runs a custom ~500-LOC TypeScript ReAct harness
(`services/agent-claw/`) with 16 lifecycle hook points, 25 registered
hooks, DB-backed sessions / plans / todos, multi-provider routing via
LiteLLM, a 4-signal confidence ensemble that includes a cross-model term,
tool forging, and a reanimator daemon for stalled-session resumption.
Phases A–F.2 of the Claw Code redesign are complete; the harness is
working and tagged at `v1.0.0-claw`.

Two things have changed since the harness was originally built (ADR 004):

  1. **Anthropic shipped the Claude Agent SDK** with first-class MCP,
     hooks, sub-agents, sessions with pluggable persistence, prompt
     caching, extended thinking, and an `AskUserQuestion` / `canUseTool` /
     `defer` triad that maps almost 1:1 onto ChemClaw's
     `ask_user` / permission resolver / reanimator pattern.
  2. **The benchmark gap that justified custom loops in 2025 has
     closed.** A maintained SDK now ships features that ChemClaw's
     bespoke harness implements by hand (parallel tool batching, mid-turn
     compaction, session persistence, plan mode, sub-agent dispatch).

The decision-bearing question: if these existed when ADR 004 was written,
would we have built the custom harness at all, or used the SDK and spent
the engineering on the layers above it (skills, optimizers, KG, wiki,
synthesis-campaign orchestration)?

This ADR answers that for the *hypothetical fresh-start case*. It does
not propose migrating the running production agent. The migration cost
(porting 25 hooks, regression-testing against the golden set, reworking
sessions, dropping cross-model confidence, retiring LiteLLM as the
chokepoint) is substantial and the maintenance savings alone do not
justify it. Recording the alternative here lets a future redesign or a
sibling project pick it up without re-running the discovery.

---

## Decision (hypothetical fresh-start build)

For a greenfield ChemClaw-equivalent built today, the recommendation is:

  * **Anthropic Agent SDK (TypeScript)** as the agent loop. Hooks,
    sub-agents, MCP, sessions, prompt caching, extended thinking, plan
    mode — all delegated.
  * **Anthropic models direct.** Skip LiteLLM. Egress redaction runs as
    an SDK pre-LLM hook instead of a separate proxy service.
  * **Existing data + projection layers unchanged.** Postgres + Neo4j +
    projectors + RLS three-role model + pgvector + the DB-backed
    registries (prompt, config, flag, permission, redaction) all stay.
  * **Self-improvement layer unchanged.** DSPy GEPA optimizer, skill
    promoter, forged-tool validator, evaluator harness all stay as
    standalone cron services. They consume the agent's output through
    the same DB tables, regardless of runtime.
  * **Synthesis-campaign orchestration deferred to a durable workflow
    engine in v2.** v1 keeps the current `synthesis_campaigns` state
    machine + skill-driven advancement; v2 moves it under Restate or
    DBOS once a second autonomous workflow type justifies the operations
    cost.
  * **Five features regress in v1** vs. today's ChemClaw and are
    accepted as such: multi-provider routing, cross-model confidence
    signal, two-stage HTTP-approval plan mode, `post_tool_batch` hook,
    custom-instructions compaction (`/compact <instructions>`).

What stays as bespoke ChemClaw work either way: confidence ensemble,
skill packs + maturity tiers, fact-id / foundation / wiki guards, tool
forging (whenever it returns), RLS via `withUserContext` /
AsyncLocalStorage in tool implementations, redaction pattern library,
KG and wiki projections, MCP token minting.

---

## Verified primary-source findings

Three SDK capabilities were verified against official docs and the
TypeScript SDK source before the recommendation was finalised. All three
came back favourable.

  1. **Mid-turn pause for user input — YES, native.** The SDK ships an
     `AskUserQuestion` tool plus a `canUseTool` callback plus a `defer`
     hook decision that cleanly exits the process and persists the
     session for later resumption. This is essentially a 1:1 match for
     ChemClaw's `ask_user` → `AwaitingUserInputError` → reanimator-resume
     pattern. (Sources: `code.claude.com/docs/en/agent-sdk/user-input`,
     `code.claude.com/docs/en/agent-sdk/sessions`.)
  2. **Dynamic tool filtering — sufficient via per-`query()`
     `allowedTools`.** The SDK does not allow tool-list mutation
     mid-query, but skills in ChemClaw change between user messages
     (via slash verbs), not within a single agent turn. Computing
     `allowedTools` once at the start of each `query()` from the active
     skill set is equivalent to the current `apply-skills` pre_turn
     hook for all real use cases. Tool search (load-on-demand for large
     catalogs) is a net upgrade as the chemistry MCP surface grows.
     (Source: `code.claude.com/docs/en/agent-sdk/tool-search`.)
  3. **Session persistence — pluggable via `SessionStore` interface.**
     The SDK exports a `SessionStore` interface with `append` / `load` /
     optional `listSessions` / `delete` / `listSubkeys`. A reference
     `PostgresSessionStore` adapter ships in
     `examples/session-stores/` of the SDK repo. RLS enforcement, etag
     optimistic locking, and a sidecar `awaiting_question` column are
     wired *inside* the adapter using ChemClaw's existing
     `withUserContext` helper — ~100 LOC for the full ChemClaw shape.
     (Source: `code.claude.com/docs/en/agent-sdk/session-storage`,
     `github.com/anthropics/claude-agent-sdk-typescript`.)

The SDK does not provide built-in concurrency control or RLS hooks for
the session store, but neither is a load-bearing absence — the adapter
handles both. The SDK also does not expose a `post_tool_batch` hook or a
way to inject a custom compaction prompt; these are real but low-impact
losses (nothing in ChemClaw critically depends on either).

---

## Self-improvement layer (unaffected by the SDK choice)

The optimizers — DSPy GEPA prompt optimization
(`services/optimizer/gepa_runner/`), skill promotion
(`services/optimizer/skill_promoter/`), forged-tool nightly validation
(`services/optimizer/forged_tool_validator/`), shadow serving via
`shadow_until`, the `/eval` slash verb — all live *above* the agent
loop. They read and write `prompt_registry`, `skill_library`,
`skill_promotion_events`, `forged_tool_validation_runs`, and
`agent_sessions`; they never call into the harness. The runtime is the
consumer of their outputs, not their author.

The four SDK capabilities the optimizers consume are all supported:

  * Custom system prompt per run — `query({ systemPrompt })`.
  * Constrained tool set per run — `query({ allowedTools })`.
  * Output and tool-call capture — async iterator over messages.
  * Replay — independent of runtime; just call `query()` with the new
    inputs.

GEPA drives the SDK exactly as it drives the current harness today. The
one optimizer-touching consequence of the SDK switch is the
cross-model confidence term being dropped (Anthropic-only); the
remaining 3 signals (verbalized + Bayesian + calibrated) re-weight and
GEPA continues to score against the new ensemble. No other optimizer
code changes.

This is itself the strongest argument for the SDK route: the
high-differentiation ChemClaw engineering lives in the optimizers and
the data layer, not in the loop. Spending engineering on a custom loop
is spending on the generic part.

---

## LOC accounting

Rough estimate for the agent layer in a fresh-start build, vs. today.

| Component | Today | Fresh-start |
|---|---|---|
| Loop + lifecycle + step.ts + hook-loader | ~1000 | 0 (Anthropic ships it) |
| 16 real hooks → SDK lifecycle | ~400 | ~400 (unchanged) |
| 9 telemetry stubs | ~150 | ~150 |
| Session machinery (etag, plan store, reanimator wiring) | ~150 | ~100 (`SessionStore` adapter) |
| Plan-mode (two-stage HTTP approval flow) | ~150 | 0 (dropped — see below) |
| Chained execution loop wrapping `query()` | n/a | ~50 |
| SSE event taxonomy translation | n/a | ~80 |
| Wall-clock budget (`setTimeout` → `AbortController`) | included in loop | ~15 |
| Per-query `allowedTools` from active skills | included in apply-skills | ~30 |
| `RequestContext` AsyncLocalStorage helpers | ~50 | ~50 |
| Reanimator (cron poll → `query({ resume })`) | ~100 | ~50 |
| **Total agent-layer code** | **~2000** | **~925** |

The fresh-start design is roughly half the agent-layer LOC of today, and
offloads loop maintenance entirely.

---

## Five accepted regressions

  1. **Multi-provider routing.** The Anthropic SDK is Anthropic-only.
     Cross-model confidence (0.25 weight in the ensemble) drops; the
     remaining 3 signals re-weight.
  2. **Two-stage plan mode (emit JSON → store → HTTP `/approve` →
     execute).** Replaced with `AskUserQuestion` at the decision point,
     or SDK-native `permissionMode: "plan"` (read-only exploration) for
     genuine plan-then-execute flows. Drops `core/plan-mode.ts`,
     `agent_plans`, the approve/reject routes, and the `plan_step` /
     `plan_ready` SSE events. The whole-plan upfront approval pattern is
     theater for most workloads; HITL at the decision point is both
     smaller and more correct.
  3. **`post_tool_batch` hook.** Per-tool `post_tool` still fires;
     batch-collective reasoning is no longer expressible directly. No
     current ChemClaw hook critically depends on this.
  4. **Custom compaction prompt** (`/compact <instructions>`). The SDK's
     compaction runs with its own internal prompt; you cannot inject
     user-supplied summary instructions. Drop the `/compact` slash
     command.
  5. **`defer` as a fourth permission rung.** Collapse into `ask` plus
     route-level switching for plan-vs-execute. ~10 LOC consequence.

---

## Workflow engine for autonomous campaigns (v2, deferred)

ChemClaw's `synthesis_campaign_orchestrator` skill plus
`advance_synthesis_campaign` builtin currently put the multi-day
campaign state machine *inside the agent*. This violates the
CLAUDE.md rule "plumbing is deterministic, never put LLM reasoning in
these paths" and means the reanimator is a homegrown durable-execution
layer with best-effort poll semantics.

A durable workflow engine — **Restate** (single binary, Postgres-backed,
TS-native) preferred for ChemClaw's operational profile, or **DBOS**
(workflow as Postgres transactions) as a close second, or **Temporal**
self-hosted as the conservative pharma-regulated choice — moves the
state machine to deterministic workflow code with crash-safe checkpoints,
native long sleeps, signals, cancellation, and versioning. The agent is
invoked as an activity at decision points only ("which batch next?",
"die or continue?"); deterministic plumbing (dispatch, wait, read
results, gate checks) lives in workflow code.

This is deferred from v1 because adding a workflow engine before there
are *two* distinct autonomous workflow types is operational overhead
without payoff. The trigger to add it: a second long-running workflow
(autonomous DR campaigns, scheduled re-validation, multi-day
optimisation runs) joins synthesis campaigns as a first-class workload.
Until then, the SDK alone plus the existing `synthesis_campaigns`
machinery is sufficient.

**Nextflow is not an alternative to the workflow engine.** It is a
scientific-pipeline DAG executor (same category as Airflow / Dagster /
Snakemake) and belongs *beneath* the workflow engine as the compute
fan-out layer for embarrassingly-parallel work — bulk DFT runs, DRFP
fingerprinting of large corpora, library screening, chemprop retraining.
ChemClaw doesn't need this today; the trigger is "compute that needs
HPC scheduling" or "compute cost where Nextflow's per-process resume
cache would actually save money."

**`pg-boss` as the halfway house.** If the reanimator's best-effort
polling becomes painful before v2 workflow-engine adoption is
justified, replacing the reanimator with `pg-boss` (Postgres-backed job
queue) is a bounded ~80 LOC change that fixes the worst failure mode
without committing to a real workflow engine.

---

## Alternatives considered

  * **A — Anthropic Agent SDK** *(chosen for hypothetical fresh-start)*:
    above.
  * **B — OpenAI Agents SDK**: peer maturity, equivalent feature surface
    (handoffs, guardrails, sessions, tracing). No specific advantage for
    chemistry over Anthropic; loses Anthropic's prompt-caching
    aggressiveness and controllable extended thinking. Picks up
    OpenAI lock-in instead of Anthropic lock-in.
  * **C — Vercel AI SDK** *(= current architecture)*: provider-agnostic,
    no loop / hooks / sub-agents / sessions; you build all of those.
    This is what the current ChemClaw harness wraps. Pick only if
    multi-provider is a hard requirement.
  * **D — LangGraph**: explicit graph state machine, very auditable, very
    verbose. Plausible for pharma audit stories where "the agent
    decided" is a worse explanation than "step 3 of the documented
    graph fired." Loses ReAct freedom; the graph is the planner. Viable
    fallback if regulatory auditability becomes the dominant constraint.
  * **E — Mastra**: rejected. Already tried and dropped in Phase A of
    the original harness rebuild (see CLAUDE.md). No re-evaluation
    without a written postmortem of why it was dropped.
  * **F — Pydantic AI**: Python-only. Forces an orchestration-layer
    language flip from TypeScript. Only relevant if a separate
    Python-orchestration variant is being built; not applicable to a
    ChemClaw-equivalent rebuild.
  * **G — Roll-your-own** *(= status quo)*: the current ChemClaw
    harness. Maximum control, all maintenance cost, all
    cross-cutting-feature drift risk. Pick only if a specific feature
    cannot be expressed in the SDK shape; no such feature was
    identified during this evaluation.

Workflow-engine alternatives considered for v2 (not v1):

  * **Restate** *(preferred for ChemClaw)*: single binary, Postgres-backed,
    TS-native, low operational overhead. Young but conceptually
    aligned with ChemClaw's "Postgres is the system of record" stance.
  * **DBOS** *(close second)*: workflow code runs in Postgres
    transactions. Same alignment story, similarly young.
  * **Temporal self-hosted** *(conservative)*: heaviest operations,
    most production-tested. Pick if regulatory or insurance
    requirements force a battle-proven engine.
  * **Inngest**: TS-native, well-engineered, but per-step cloud pricing
    punishes fine-grained workflows like synthesis campaigns. Skip.
  * **Cloud-managed** (Step Functions, Azure Durable Functions, Cloud
    Workflows): JSON state machines (Step Functions) are awful for
    branching/looping; Azure Durable Functions is reasonable if Azure
    lock-in is acceptable.
  * **Airflow / Prefect / Dagster / Argo / Flyte / Kestra**: wrong
    category (batch DAG-per-run executors, not durable runtimes). Not
    alternatives for the workflow-engine slot. Useful elsewhere in the
    stack for ETL.

---

## Microsoft Copilot integration

ChemClaw can be exposed in Microsoft 365 Copilot / Teams / Copilot
Studio through three patterns; the integration sits at the API surface
and is *independent of the agent runtime choice*. Whether ChemClaw runs
on the custom harness or the Anthropic SDK, the Copilot wiring is the
same.

  * **Pattern 1 — ChemClaw as backend, Copilot as UI.** A Copilot
    Studio custom connector wraps `POST /api/chat`; Entra ID OBO
    chains the user identity through; the SSE stream is aggregated
    server-side into an Adaptive Card response. ~200 LOC of glue in a
    new `services/copilot-connector/` service.
  * **Pattern 2 — ChemClaw decomposed as MCP servers.** Copilot
    Studio (which adopted MCP in 2025) consumes individual ChemClaw MCP
    tools as a Copilot agent's toolbox. The reasoning happens in the
    Microsoft runtime; ChemClaw's agent layer is bypassed. Useful for
    ad-hoc tool exposure; loses skills / maturity / confidence /
    redaction / the self-improvement loop.
  * **Pattern 3 — Agent handoff via Bot Framework / Foundry.** ChemClaw
    is registered as a specialist agent; Copilot routes pharma R&D
    queries to it. Same wiring as Pattern 1 with an agent-to-agent
    envelope.

The scenario that *does* invalidate the SDK recommendation: a
**"Microsoft AI only"** compliance mandate (no Anthropic API egress).
Under that policy the agent runtime shifts to Microsoft Semantic Kernel
or Azure AI Agent Service against Azure OpenAI, and this ADR's decision
is moot. Worth verifying with compliance early — pharma orgs often have
strong policies on which AI providers may process which data classes.

---

## Consequences

If a fresh-start project ever executes on this evaluation:

  * Agent-layer code drops from ~2000 to ~925 LOC.
  * Anthropic vendor lock-in becomes architectural, not just operational.
  * Five features regress (listed above) and are accepted.
  * The self-improvement layer, data layer, KG, wiki, and MCP tool
    services are unchanged.
  * Synthesis-campaign orchestration uses the existing skill-driven
    state machine in v1; a durable workflow engine joins the stack in
    v2 when a second autonomous workflow type lands.

If no project executes on it: this ADR is recorded research. Next time
the question is asked, the answer is here. The current production
harness is unchanged.

---

## Related ADRs

  * ADR 004 — Harness Engineering: Custom Loop Over Framework (the
    decision this ADR re-evaluates against today's landscape).
  * ADR 007 — Hook System Rebuild (the hook contract that maps onto the
    SDK's lifecycle).
  * ADR 008 — Collapsed ReAct Loop (the single-loop invariant; the SDK
    rewrite preserves it as `query()` is the only loop).
  * ADR 009 — Permission and Decision Contract (the `deny > defer > ask
    > allow` aggregation; the SDK supports `deny > ask > allow` plus
    `defer` as a decision type for plan mode and async resume).
  * ADR 011 — Synthesis-Campaign Orchestration (the workload that
    motivates v2 durable workflow engine adoption).
