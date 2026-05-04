# Hooks + Skills + Permissions Audit — 2026-05-03

Read-only audit of the lifecycle hook system, skill loader, and the
permission resolver chain. Scope: every YAML in `hooks/`, every TS
implementation in `services/agent-claw/src/core/hooks/`, the resolver
under `services/agent-claw/src/core/permissions/`, every skill in
`skills/`, and every harness call site.

Severity legend (matches the rest of the 2026-05-03 review series):
- **P0** — correctness/security broken in a runnable code path
- **P1** — stability risk / regression that surfaces under realistic conditions
- **P2** — maintainability rot / inert wiring
- **P3** — nice-to-have cleanup

---

## Executive Summary

| Severity | Finding | File:line | Fix sketch |
|---|---|---|---|
| **P1** | Permission policies enforced on the SSE branch of `/api/chat` only — every other harness call site (`chat-non-streaming` via `agent.run`, `/api/chat/plan/approve`, `/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`, `/api/internal/sessions/:id/resume`, `/api/deep_research`, `dispatch_sub_agent`) bypasses the resolver. A `permission_policies` row of `decision='deny'` is silently inert on 7 of 8 surfaces. | `services/agent-claw/src/routes/chat.ts:405` (only `permissions:` site); `routes/chat-non-streaming.ts:120` (uses `agent.run` which strips `permissions`); `routes/sessions-handlers.ts:169,278`; `routes/plan.ts:104`; `routes/deep-research.ts:169,220`; `core/sub-agent.ts:181`; `core/harness.ts:300-323` (`buildAgent.run` does not forward a `permissions` option) | Thread `permissions: { permissionMode: "enforce" }` through every site. `buildAgent` must accept `permissions` in `AgentDeps` and forward it on every `run()` so non-streaming `/api/chat` is not silently exempted. |
| **P1** | Skill loader ignores both `skill_library.maturity` and `skill_library.shadow_until` — Phase E's "FOUNDATION skills must clear higher gate" and Phase E shadow-serving (CLAUDE.md "Persistent agent sessions") are not implemented. Loader selects all `active=TRUE` rows regardless of tier or shadow window. | `services/agent-claw/src/core/skills.ts:331-391` (`loadFromDb` query); `db/init/06_skill_library.sql:18` (`shadow_until` column exists); `db/init/17_unified_confidence_and_temporal.sql:115-116` (`maturity` column exists) | Add `maturity` + `shadow_until` to the SELECT; promote shadow rows only after `shadow_until < NOW()`; gate FOUNDATION load on a separate confidence check. |
| **P1** | `inchikey_from_smiles` referenced by 2 skills (`library_design_planner`, `qm_pipeline_planner`) but **not registered** in `bootstrap/dependencies.ts`. When either skill is active and the agent obeys the prompt, the LLM emits a tool call the harness can't dispatch. | `skills/library_design_planner/SKILL.md:6`; `skills/qm_pipeline_planner/SKILL.md:8`; `services/agent-claw/src/bootstrap/dependencies.ts` (no `registerBuiltin("inchikey_from_smiles", …)`) | Either register the missing builtin against `mcp-rdkit` (analogous to `canonicalize_smiles`), or remove the line from both skills. |
| **P1** | Resolver-level "ask" decision is silently downgraded to "allow" at the pre_tool stage. The route-level resolver returns `ask`, but `core/step.ts:163-173` logs and continues. There is no UI / SSE event for the user to actually answer. | `services/agent-claw/src/core/step.ts:163-173`; `services/agent-claw/src/core/permissions/resolver.ts:101-106` | Either fold "ask" into "deny" until UI lands, or wire an SSE event analogous to `awaiting_user_input`. |
| **P2** | `hooks/permission.yaml` claims `enabled: true` and `lifecycle: permission_request`, and `permission.ts` reads from `getPermissionPolicyLoader()` — but the loader is **only consulted when a route passes `permissions: { permissionMode: "enforce" }`**. The DB-backed policy hook is therefore effectively dead on every route except SSE chat. The YAML file's "operators can extend this hook" prose is misleading. | `hooks/permission.yaml`; `services/agent-claw/src/core/hooks/permission.ts:17-59`; `services/agent-claw/src/core/permissions/resolver.ts:115-127` (only `enforce` mode actually dispatches `permission_request`) | Document the wiring in the YAML, or — better — make `default` mode also consult the hook (resolver already does), then thread `permissions:` into all routes. |
| **P2** | Stale comment in `core/types.ts:287` says "the resolver only fires when a route passes a `permissions` option to runHarness, which no production route does today." This contradicts `chat.ts:405` which does. The same comment lives in `core/permissions/resolver.ts:4-8`. | `core/types.ts:287`; `core/permissions/resolver.ts:4-8` | Update both comments to "only the SSE branch of /api/chat, no other route". |
| **P2** | `session_end` hook is dispatched (chained-harness.ts:368) but no built-in registrar exists. CLAUDE.md "Harness Primitives" section flags this as expected; absence of the listener means session-end-time persistence (token cap reset, audit row, optimizer signal) has no attach point. | `services/agent-claw/src/core/chained-harness.ts:368`; `hooks/` (no `session-end.yaml`) | Land a no-op `session-end` hook + YAML for parity with `session-events`, OR document the intentional gap. |
| **P2** | Sub-agents have no recursion guard. `SUB_AGENT_TOOL_SUBSETS` happens to omit `dispatch_sub_agent` from each subset, so the depth limit is implicit (1 deep) but only enforced by the absence of a tool, not by an explicit cap. A future skill or operator who adds `dispatch_sub_agent` to a subset triggers unbounded recursion. | `services/agent-claw/src/core/sub-agent.ts:34-53` | Add an explicit depth counter in `ToolContext` + reject `spawnSubAgent` when depth ≥ N. |
| **P2** | Sub-agent inherits no `permissions` option. Even if `/api/chat` SSE turns on `enforce`, the moment the LLM calls `dispatch_sub_agent`, the spawned harness runs with no resolver — DB permission policies do not apply to sub-agents. | `services/agent-claw/src/core/sub-agent.ts:181-188` | Plumb the parent's `PermissionOptions` through `SubAgentDeps` and pass to `runHarness`. |
| **P2** | `tag-maturity` post_tool hook silently swallows DB errors via the `try { … } catch {}` at `tag-maturity.ts:125-127`. A misbehaving artifacts INSERT yields no log and no metric. The hook also mutates `output.artifact_id` AFTER any post_tool hook earlier in the chain has already read the output — but order in `BUILTIN_REGISTRARS` is `tag-maturity`, `anti-fabrication`, `source-cache`, so this happens to work, but the dependency is implicit. | `services/agent-claw/src/core/hooks/tag-maturity.ts:125-127` | Log the error structurally via `getLogger`; document the inter-hook ordering invariant in the YAML. |
| **P2** | `redact-secrets` hook does not honour the per-call `AbortSignal`. The hook is `O(n×k)` over `payload.finalText` plus 5 regex passes. With the `MAX_REDACTION_INPUT_LEN = 5MB` cap, the worst case is bounded by the cap but a hook timeout cannot interrupt mid-scan. | `services/agent-claw/src/core/hooks/redact-secrets.ts:65-115` | Optional: short-circuit when `_options?.signal?.aborted`; or keep as-is since the input-length cap already bounds CPU. |
| **P3** | `MIN_EXPECTED_HOOKS = 11` matches the current YAML count exactly. Comment at `bootstrap/start.ts:25` correctly says "9 pre-rebuild + session-events + permission" so the assertion is well-aligned. No drift. | `services/agent-claw/src/bootstrap/start.ts:29` | None — record-keeping. |
| **P3** | `hooks/permission.yaml` and `hooks/session-events.yaml` declare `definition.description` but the loader does not surface this in any startup log or `/api/admin/permission-policies` listing. Operators who try to discover what's wired must read the YAML. | `hooks/*.yaml`; `services/agent-claw/src/core/hook-loader.ts:307` | Have `loadHooks` log each registered hook's name + lifecycle + `description` snippet at INFO once. |
| **P3** | `hooks/source-cache.yaml` uses non-standard `tool_id_pattern`, `implementation`, and `stale_check_phase` fields. The loader ignores them. Source of truth is `services/agent-claw/src/core/hooks/source-cache.ts:36`. The YAML decoration is documentation-only. | `hooks/source-cache.yaml` | Add to `HookYaml` interface as documented advisory fields, or delete from the YAML. |

---

## Hook Parity Matrix

YAML files: 11. TS implementations: 11. `BUILTIN_REGISTRARS` entries: 11.
All three counts are aligned and `MIN_EXPECTED_HOOKS = 11` matches.

| YAML file | `name` declared | Lifecycle phase | TS impl in `core/hooks/` | `BUILTIN_REGISTRARS` entry | Test file(s) | `order` honored? | `timeout_ms` honored? | `condition` honored? |
|---|---|---|---|---|---|---|---|---|
| `anti-fabrication.yaml` | `anti-fabrication` | `post_tool` | `anti-fabrication.ts` | yes (hook-loader.ts:124) | `hooks-anti-fabrication.test.ts` | yes (default 100) | n/a — no `timeout_ms` set; built-in registrar would log it as advisory | n/a — no `condition` set |
| `apply-skills.yaml` | `apply-skills` | `pre_turn` | `apply-skills.ts` | yes (hook-loader.ts:136-138) | partial — extended-hooks-fire only | yes | n/a | n/a |
| `budget-guard.yaml` | `budget-guard` | `pre_tool` | `budget-guard.ts` | yes (hook-loader.ts:122) | `hooks-budget-guard.test.ts` | yes | n/a | n/a |
| `compact-window.yaml` | `compact-window` | `pre_compact` | `compact-window.ts` | yes (hook-loader.ts:128-134) | `compact-window-signal.test.ts`, `compactor.test.ts` | yes | n/a (built-in advisory; the hook reads `tokenBudget` from `HookDeps` instead) | n/a |
| `foundation-citation-guard.yaml` | `foundation-citation-guard` | `pre_tool` | `foundation-citation-guard.ts` | yes (hook-loader.ts:125) | `hooks-foundation-guard.test.ts` | yes | n/a | n/a |
| `init-scratch.yaml` | `init-scratch` | `pre_turn` | `init-scratch.ts` | yes (hook-loader.ts:123) | `hooks-anti-fabrication.test.ts` | yes | n/a | n/a |
| `permission.yaml` | `permission` | `permission_request` | `permission.ts` | yes (hook-loader.ts:146) | `permission-policy-loader.test.ts` | yes | n/a | n/a |
| `redact-secrets.yaml` | `redact-secrets` | `post_turn` | `redact-secrets.ts` | yes (hook-loader.ts:118) | `hooks-redact-secrets.test.ts` | yes | n/a | n/a |
| `session-events.yaml` | `session-events` | `session_start` | `session-events.ts` | yes (hook-loader.ts:141) | covered by `extended-hooks-fire.test.ts` | yes | n/a | n/a |
| `source-cache.yaml` | `source-cache` | `post_tool` | `source-cache.ts` | yes (hook-loader.ts:126) | `hooks-source-cache.test.ts` | yes | n/a | n/a |
| `tag-maturity.yaml` | `tag-maturity` | `post_tool` | `tag-maturity.ts` | yes (hook-loader.ts:121) | `hooks-tag-maturity.test.ts` | yes | n/a | n/a |

**No orphans.** Every YAML has a registrar; every TS file has a YAML.
Every `BUILTIN_REGISTRARS` key matches a YAML `name` and a TS file.

`hook-loader-coverage.test.ts:34-58` asserts the 11-hook total breakdown
(2 pre_turn + 2 pre_tool + 3 post_tool + 1 pre_compact + 1 post_turn +
1 session_start + 1 permission_request = 11). The test would catch a
silent regression where a YAML's lifecycle field drifts from the
registrar's `lifecycle.on(...)` call (parity asserted at line 70-127).

**Phase 4 extension fields.** None of the 11 production YAMLs use `order`,
`timeout_ms`, or `condition` — so the loader's behavior on these fields
exists only in `hook-loader-extensions.test.ts`. The behavior is correct
per the test suite:

- **`order`** (hook-loader.ts:230-235): ascending sort with file-name
  tiebreaker. Verified by `hook-loader-extensions.test.ts:39-72`.
- **`timeout_ms`** (hook-loader.ts:263, 300-304): forwarded to
  `lifecycle.on` for **script** hooks; **logged as advisory** for
  built-ins. The `redact-secrets-with-timeout` test at line 162-175
  confirms the advisory log path. Built-in registrars don't accept
  per-hook timeout today — a known gap, documented in the loader
  comment at line 297-300.
- **`condition`** (hook-loader.ts:320-339): resolves
  `setting_key → env_var → default`. Verified at
  `hook-loader-extensions.test.ts:86-141`.

---

## MIN_EXPECTED_HOOKS Reconciliation

```
services/agent-claw/src/bootstrap/start.ts:29
const MIN_EXPECTED_HOOKS = 11;
```

Comment at line 25-28 says: "11 = 9 pre-rebuild hooks + session-events
(Phase 4B) + permission (Phase 6). Bump every time BUILTIN_REGISTRARS
gains an entry so a silent failure to load a new hook trips the startup
gate instead of quietly downgrading the safety net."

`BUILTIN_REGISTRARS` map size: **11** (counted at hook-loader.ts:117-147).
`hooks/*.yaml` count: **11**.
Result: **aligned**. No bump needed.

---

## Hook AbortSignal Compliance Matrix

CLAUDE.md: "Per-hook AbortController + timeout (default 60s): if a hook
doesn't return in time, its signal aborts so cooperative handlers can
bail. Hooks that don't honour the signal will still hold the dispatcher
hostage." `lifecycle.ts:167-272` implements `Promise.race(handler,
abortRejection)` so a handler that ignores its signal still releases the
dispatcher within the configured timeout — but its work continues
running in the background.

W1.7 in the prior audit named three offenders. Confirming current state:

| Hook | Honors `options.signal`? | Evidence | Risk if it doesn't |
|---|---|---|---|
| `compact-window` | **YES** (fixed since prior audit) | `compact-window.ts:66` forwards `options.signal` into the compactor's LLM call | Largest blast radius — Haiku call is the longest-running hook. Now correctly cancels mid-call. |
| `tag-maturity` | **YES** (fixed since prior audit) | `tag-maturity.ts:151` forwards `options.signal`; the DB INSERT branch at line 102 short-circuits when `signal?.aborted` | Pool churn for cancelled requests. Now skipped. |
| `source-cache` | **YES** (fixed since prior audit) | `source-cache.ts:497` short-circuits with `if (options.signal.aborted) return {}` | Pool churn — DB writes for cancelled-by-client requests. Now skipped. |
| `anti-fabrication` | n/a (in-memory only, sub-millisecond) | `anti-fabrication.ts:78-99` is pure-JS Set ops over the output object | None — completes faster than any plausible timeout. |
| `apply-skills` | n/a (in-memory only) | `apply-skills.ts:18-39` mutates the system message + scratchpad | None. |
| `budget-guard` | n/a (in-memory only, throws synchronously) | `budget-guard.ts:43-64` reads scratchpad and throws | None. |
| `foundation-citation-guard` | n/a (in-memory only) | `foundation-citation-guard.ts:29-94` is pure scratchpad lookups | None. |
| `init-scratch` | n/a (in-memory only) | `init-scratch.ts:16-23` clears one Map key | None. |
| `permission` | n/a (cache lookup, no I/O) | `permission.ts:17-59` consults the in-process loader cache (60s TTL) | None — DB hits live in the loader's `refreshIfStale`, not in the hook callback. |
| `redact-secrets` | **NO** (acceptable) | `redact-secrets.ts:126-159` runs 5 regex passes; the `MAX_REDACTION_INPUT_LEN = 5MB` cap bounds CPU but `_options.signal` is not consulted | Acceptable: bounded by 5MB cap and length-bounded patterns. |
| `session-events` | n/a (no-op) | `session-events.ts:16-24` returns `{}` | None. |

**Summary.** Three previously-flagged offenders (compact-window,
tag-maturity, source-cache) all honour the AbortSignal now. The only
remaining hook that ignores its signal is `redact-secrets`, which is
input-bounded by `MAX_REDACTION_INPUT_LEN`. **No P0 or P1 abort issues.**

---

## Decision Aggregation Findings

`Lifecycle.dispatch` (lifecycle.ts:147-276) implements
`deny > defer > ask > allow` aggregation via `mostRestrictive`
(hook-output.ts:60-71). Tests at `lifecycle-decisions.test.ts:28-187`
lock the contract:

| Scenario | Verified | Result |
|---|---|---|
| 3 hooks return `(allow, deny, allow)` | yes (`lifecycle-decisions.test.ts:48-77`) | aggregate = `deny`, reason follows the deny |
| First hook denies, second allows — reason from first survives | yes (`:79-104`) | first deny's reason kept |
| Two hooks return `updatedInput` — last-write-wins | yes (`:106-129`) | second hook's `updatedInput` survives |
| `{async: true}` hook excluded from aggregation | yes (`:131-149`) | sync hook's decision wins |
| Zero hooks → `{decision, reason, updatedInput}` all `undefined` | yes (`:151-161`) | all undefined |
| `ask + defer` → defer wins | yes (`:163-187`) | defer |

**Hook timeout = "throw on `pre_tool`, log on others".**
`lifecycle.ts:250-269` (catch arm): for `pre_tool`, the timeout error
propagates so callers (budget-guard semantics) see it. For all other
points, the error is logged as `event: hook_failed` and the next hook
runs. **A timed-out hook on `permission_request` therefore counts as
"no opinion"** (which the resolver translates to `allow` in `enforce`
mode per `resolver.ts:126-127`, or `deny` in `default` mode per
`resolver.ts:154`). CLAUDE.md does not document this — this finding
adds the answer.

**Malformed decision shape.** A hook returning a `permissionDecision`
that isn't `"allow" | "deny" | "ask" | "defer"` would slip through the
aggregator (lifecycle.ts:241-246 trusts the type). There is no runtime
guard. Mitigation: every built-in hook is typed via
`HookSpecificOutput`, but a script hook (rare; none ship today) could
emit garbage. **Low risk** — recommend a Zod parse at dispatch time as
a defense-in-depth follow-up.

---

## Permission Posture per Call Site

`permissionMode` in CLAUDE.md sense: only `"enforce"` engages the
DB-backed `permission_policies` chain. Without a `permissions` option
to `runHarness` / `runChainedHarness`, the resolver is **skipped
entirely** (step.ts:120) — only the `pre_tool` hook chain (which
includes `foundation-citation-guard` and `budget-guard`) gates tool
execution.

| Call site | Path | `permissions:` passed? | Resolver fires? | DB policy enforced? |
|---|---|---|---|---|
| `/api/chat` SSE | `routes/chat.ts:387-406` | YES — `{ permissionMode: "enforce" }` | yes (chat.ts:405) | yes |
| `/api/chat` non-streaming | `routes/chat-non-streaming.ts:118-121` via `agent.run` | NO — `buildAgent.run` (`harness.ts:300-323`) takes no `permissions` arg, so `runHarness` is called without it | no | **no — silently bypassed** |
| `/api/chat/plan/approve` | `routes/plan.ts:104-113` | NO | no | **no** |
| `/api/sessions/:id/plan/run` | `routes/sessions-handlers.ts:169-188` (calls `runChainedHarness`) | NO | no | **no** |
| `/api/sessions/:id/resume` (header-authed) | `routes/sessions-handlers.ts:278-291` (`executeResume`) | NO | no | **no** |
| `/api/internal/sessions/:id/resume` (JWT-authed reanimator) | `routes/sessions-handlers.ts:362+` → same `executeResume` | NO | no | **no** |
| `/api/deep_research` non-streaming | `routes/deep-research.ts:169-177` | NO | no | **no** |
| `/api/deep_research` SSE | `routes/deep-research.ts:220-229` | NO | no | **no** |
| `dispatch_sub_agent` | `core/sub-agent.ts:181-188` | NO | no | **no** |
| Plan-mode preview | `routes/chat-plan-mode.ts` (`createPlan`-only path; tools never execute) | n/a — preview emits `plan_step` SSE events, no harness loop | n/a | n/a |

**Recommended changes (highest priority first).**

1. `routes/sessions-handlers.ts:169` and `:278` — both `runChainedHarness`
   call sites must enable enforce. Cron-driven reanimator
   (`/api/internal/sessions/:id/resume`) is the most dangerous to leave
   open: it runs as the original user without a human in the loop.
2. `core/harness.ts:300-323` (`buildAgent`) — accept `permissions` and
   forward to `runHarness`. Without this fix, the non-streaming
   `/api/chat` path silently bypasses every DB policy even after the
   SSE branch was wired.
3. `routes/plan.ts:104` and `routes/deep-research.ts:169,220` — pass
   `permissions: { permissionMode: "enforce" }`.
4. `core/sub-agent.ts` — plumb parent's `PermissionOptions` through
   `SubAgentDeps` so spawned harnesses inherit policy posture.

This is `BACKLOG.md:6` and the prior audit's F-06; raising visibility:
the gap is **5 production routes + 1 internal route + sub-agents = 7
exempt surfaces** and only 1 enforced, not "1 done, 5 remaining" as
BACKLOG implies.

---

## Skills Inventory & Validation Matrix

`skills/` has 18 directories (excluding `_template`). All load via
`SkillLoader.load()` at startup (skills.ts:138-179). DB skills load via
`loadFromDb` (skills.ts:331-391) — not exercised below since no
`skill_library` rows exist in this clone.

| Skill ID | Tools declared | All registered? | Notes |
|---|---|---|---|
| `aizynth_route` | canonicalize_smiles, propose_retrosynthesis, search_knowledge, query_kg | yes | clean |
| `askcos_route` | canonicalize_smiles, propose_retrosynthesis, search_knowledge, query_kg, propose_hypothesis | yes | clean |
| `chemprop_yield` | predict_reaction_yield, predict_molecular_property, find_similar_reactions, statistical_analyze, search_knowledge | yes | clean |
| `closed-loop-optimization` | canonicalize_smiles, recommend_conditions, design_plate, start_optimization_campaign, recommend_next_batch, ingest_campaign_results, predict_yield_with_uq, manage_todos, find_similar_reactions, query_kg | yes | clean |
| `condition-design` | canonicalize_smiles, recommend_conditions, find_similar_reactions, assess_applicability_domain, score_green_chemistry, predict_reaction_yield, search_knowledge, query_kg, fetch_original_document | yes | clean |
| `condition-design-from-literature` | canonicalize_smiles, assess_applicability_domain, find_similar_reactions, search_knowledge, fetch_original_document, recommend_conditions, score_green_chemistry, query_kg | yes | clean |
| `cross_learning` | find_similar_reactions, expand_reaction_context, statistical_analyze, synthesize_insights, propose_hypothesis, query_kg | yes | clean |
| `deep_research` | search_knowledge, fetch_full_document, fetch_original_document, query_kg, check_contradictions, find_similar_reactions, expand_reaction_context, statistical_analyze, synthesize_insights, propose_hypothesis, draft_section, mark_research_done, analyze_csv | yes | clean |
| `hte-plate-design` | canonicalize_smiles, recommend_conditions, design_plate, predict_yield_with_uq, export_to_ord | yes | clean |
| `late-stage-functionalization` | canonicalize_smiles, recommend_conditions, assess_applicability_domain, score_green_chemistry, find_similar_reactions, predict_yield_with_uq, search_knowledge, fetch_original_document, query_kg | yes | clean |
| `library_design_planner` | canonicalize_smiles, **inchikey_from_smiles**, generate_focused_library, find_matched_pairs, find_similar_compounds, substructure_search, match_smarts_catalog, classify_compound, run_chemspace_screen, enqueue_batch, inspect_batch, workflow_define, workflow_run, workflow_inspect, workflow_pause_resume, workflow_modify | **NO — `inchikey_from_smiles` not in registry** | P1 — see Executive Summary |
| `pharma-process-readiness` | canonicalize_smiles, find_similar_reactions, predict_yield_with_uq, assess_applicability_domain, score_green_chemistry, extract_pareto_front, manage_todos | yes | clean |
| `qc` | search_knowledge, query_kg, analyze_csv, check_contradictions, fetch_original_document, fetch_full_document | yes | clean |
| `qm_pipeline_planner` | canonicalize_smiles, **inchikey_from_smiles**, qm_single_point, qm_geometry_opt, qm_frequencies, qm_fukui, qm_redox_potential, qm_crest_screen, find_similar_compounds, classify_compound, run_chemspace_screen, enqueue_batch, inspect_batch, workflow_define, workflow_run, workflow_inspect, conformer_aware_kg_query | **NO — `inchikey_from_smiles` not in registry** | P1 — see Executive Summary |
| `retro` | find_similar_reactions, expand_reaction_context, canonicalize_smiles, search_knowledge, query_kg, propose_hypothesis | yes | clean |
| `sirius_id` | identify_unknown_from_ms, canonicalize_smiles, search_knowledge, query_kg, propose_hypothesis | yes | clean |
| `synthegy_feasibility` | canonicalize_smiles, propose_retrosynthesis, expand_reaction_context, search_knowledge, query_kg | yes | clean |
| `synthegy_retro` | canonicalize_smiles, propose_retrosynthesis, find_similar_reactions, expand_reaction_context, search_knowledge, query_kg, propose_hypothesis | yes | clean |
| `xtb_conformer` | canonicalize_smiles, compute_conformer_ensemble, search_knowledge, propose_hypothesis | yes | clean |

**Verification command (cross-check):**

```bash
# Tool IDs declared in skills:
grep -hE "^\s*-\s+[a-z_]+\s*$" skills/*/SKILL.md | grep -oE "[a-z_]+" | sort -u
# Tool IDs registered as builtins:
grep -E 'registerBuiltin\("[a-z_]+"' services/agent-claw/src/bootstrap/dependencies.ts | \
  grep -oE '"[a-z_]+"' | sort -u
```

The diff yields exactly one missing entry: `inchikey_from_smiles`.

**Orphan tools (registered, no skill / system prompt mentions them).**
Spot-check shows `dispatch_sub_agent`, `forge_tool`,
`induce_forged_tool_from_trace`, `add_forged_tool_test`,
`promote_workflow_to_tool`, `compute_confidence_ensemble`, `ask_user`,
`run_program` are not listed in any skill's `tools:` array. Most are
infrastructure tools the system prompt mentions independently (and
they're "always-on" when no skill is active per skills.ts:305-306).
The `_template/SKILL.md` correctly contains placeholders only, not
real tool ids — verified.

---

## Skill Loader Correctness

`services/agent-claw/src/core/skills.ts`:

1. **`load()` (filesystem)** — reads `skills/*/SKILL.md` synchronously.
   No DB context needed. Strict frontmatter validation throws on
   missing `id|description|version|tools` (skills.ts:99-110). Good.

2. **`loadFromDb(pool)`** — uses `withSystemContext` (skills.ts:344)
   for the `skill_library` query. CLAUDE.md correctly says: "for
   globally-scoped catalog reads (prompt_registry, skill_library,
   mcp_tools), use `withSystemContext`" — implemented per spec.
   **No `withUserContext`** is used because skill_library is global;
   correct.

3. **`maturity` column** — exists on `skill_library` per
   `db/init/17_unified_confidence_and_temporal.sql:115-116` (added
   in PR-8). The `loadFromDb` SELECT at skills.ts:353-356 does not
   include `maturity`. **The 3-tier (`EXPLORATORY`, `WORKING`,
   `FOUNDATION`) maturity model is not honoured by the loader.** No
   activation gate other than `active = true` exists; CLAUDE.md's
   "FOUNDATION skills must pass higher gate" promise is unimplemented.
   **P1.**

4. **`shadow_until` column** — exists on `skill_library` per
   `db/init/06_skill_library.sql:18` ("Phase E promotes after shadow
   period"). The `loadFromDb` query also ignores it. A skill with
   `active = true` AND `shadow_until > NOW()` (i.e. still in shadow
   serving) is loaded as if promoted. **P1 — Phase E feature
   incomplete.**

5. **Activation gate** — `WHERE active = true` at skills.ts:355. This
   is the only gate. `promote_workflow_to_tool.ts:108` inserts new
   forged tools with `active = FALSE`, requiring an admin to flip the
   bit before the LLM can dispatch them. Per W1.8 prior audit there is
   **no UI / endpoint to flip `active` to TRUE** other than direct
   SQL. Not blocking but recorded.

6. **Cap** — `getEffectiveMaxActiveSkills` (skills.ts:68-78) reads
   `agent.max_active_skills` from `config_settings` with a 1..50
   bound. Correctly defaults to `DEFAULT_MAX_ACTIVE_SKILLS = 8` when
   the registry is uninitialised (test environment).

---

## `manage_todos` and `ask_user` SSE Event Contract

**`manage_todos` → `todo_update`.**
- Tool sets `output.todos` per `manage_todos.ts:140,170,189,203,209`.
- `step.ts:233-244` triggers `streamSink.onTodoUpdate(...)` after
  `post_tool` dispatches, when `toolId === "manage_todos"` and the
  output has a `todos` array.
- SSE wiring at `streaming/sse-sink.ts:53-54` writes
  `{ type: "todo_update", todos }` to the wire.
- **Contract holds.** Each successful `manage_todos` call (create /
  update / complete / cancel / list) yields exactly one
  `todo_update` event.

**`ask_user` → `awaiting_user_input`.**
- Tool sets `ctx.scratchpad.awaitingQuestion` and throws
  `AwaitingUserInputError` (ask_user.ts:71-78).
- `runHarness` catches the error at `harness.ts:223-237`, sets
  `finishReason = "awaiting_user_input"`, **emits
  `streamSink?.onAwaitingUserInput?.(err.question)` BEFORE
  re-throwing**, so the SSE adapter can write the event even though
  the propagation continues.
- `chat.ts:362-370` deliberately strips `onAwaitingUserInput` and
  `onFinish` from the sink the route hands to the harness — the
  route owns those events because of the redaction-then-persist
  ordering. The route's `finally` block (chat.ts:453-489) lifts
  `awaitingQuestion` from scratchpad, redacts it, persists it via
  `persistTurnState`, **then** writes the SSE event.
- **Contract holds**, with the documented caveat that the SSE event
  comes after redaction. Stream ends after `awaiting_user_input` +
  `finish` events (per chat.ts wire-contract comments).

**Sub-agent / deep-research interaction with ask_user.**
`deep-research.ts:230-234` catches `AwaitingUserInputError`
explicitly. The DR route is single-turn; if a sub-agent deep within
DR throws AwaitingUserInputError, the parent harness still
propagates and DR finalises with the question. This appears
correct, but DR's route does NOT redact the question before any
sink emit — the sink in DR is built without the override of
`onAwaitingUserInput` that chat.ts performs (`deep-research.ts:213`).
**Minor concern**: a question containing a SMILES could leak through
if `runHarness` calls `streamSink?.onAwaitingUserInput?.(err.question)`
on DR's sink. **Verify whether DR's sink defines that callback** —
`makeSseSink` in `streaming/sse-sink.ts:55-72` does, and DR doesn't
strip it like chat.ts does. **P2** — possible un-redacted SMILES
leak via DR's `awaiting_user_input` SSE frame. Recommend either
(a) make `redactString` part of the sink's `onAwaitingUserInput`
default, or (b) have DR strip-and-rewrite like chat.ts does.

---

## Plan-Mode Preview

Plan mode in this codebase has **two distinct flows**, both of which
should be audited together:

1. **Streaming preview** (`routes/chat-plan-mode.ts`): when the user
   prefixes with `/plan`, the harness runs **a single
   `llm.completeJson` call** (no tool execution) to extract steps,
   builds a `Plan` object, persists it via `planStore.save`, and emits
   `plan_step` + `plan_ready` SSE events. **No tool calls execute** in
   this branch — preview is preview.
2. **Approval execution** (`routes/plan.ts:104`): on
   `POST /api/chat/plan/approve`, the route loads the saved plan and
   calls `runHarness` with the plan's stored messages. **This is where
   tool restrictions, permissions, and todos must apply.**

| Property | Preview branch | Approval branch | Issue? |
|---|---|---|---|
| Tool restrictions | n/a (no tools) | YES — uses the route's `tools` (filtered by skills) | none |
| Session scratchpad | shared with the chat session | shared (same `ctx`) | none |
| Todo state | n/a | shared (manage_todos sees the same session_id) | none |
| Permission resolver | n/a | **NO — `runHarness` called without `permissions:`** | **P1 — see Executive Summary** |
| Plan-mode hook | not declared in YAML, hook system has no plan-specific phase | n/a | none |

**The plan-mode preview / approve flow has no permission gate at
approve time.** A user who pre-builds a plan with `Bash(rm -rf /)` (or
the equivalent forged tool) and then approves it bypasses any
`permission_policies` row.

`PlanStore` is in-memory with a 5-minute TTL (plan-mode.ts:48-71). It
is **not RLS-scoped** — owner check is a JS-level
`plan.user_entra_id === user` (per plan-mode.ts:35-36). The chained
runner uses `loadActivePlanForSession` (sessions-handlers.ts:162) which
goes through the DB. So there are **two plan stores**: `planStore`
(in-memory, /chat/plan/approve) and `agent_plans` (DB, /sessions/:id/plan/run).
This is an inconsistency worth documenting; not a bug today.

---

## Foundation Citation Guard

`hooks/foundation-citation-guard.ts:29-94`:

- **Trigger**: tool input has `maturity_tier === "FOUNDATION"`.
- **Gate**: searches `obj` for keys `cited_fact_ids`, `fact_ids`,
  `evidence_fact_ids`, `source_ids` (each as a string array). For each
  cited ID, looks up `ctx.scratchpad.artifactMaturity` (a Map populated
  by the `tag-maturity` post_tool hook).
- **Action**: returns `permissionDecision: "deny"` with a structured
  reason listing the offending `EXPLORATORY` IDs. **Does not throw**
  (Phase 4A migration — comment at line 18-19 explains the change from
  throw to deny).
- **Test coverage**: `hooks-foundation-guard.test.ts` covers 9 cases
  including missing `maturity_tier`, no scratchpad, all-WORKING / all-
  FOUNDATION cited, mixed (the deny path), null/array input. **Solid.**
- **False-positive risk**: a legit FOUNDATION call that cites only
  WORKING/FOUNDATION artifacts proceeds. A FOUNDATION call that cites
  IDs the harness never saw (UUIDs not in artifactMaturity at all) ALSO
  proceeds because `maturityMap.get(unknownId) === undefined` doesn't
  match the `EXPLORATORY` check. **This is the right behavior** —
  unknown IDs are someone else's problem (e.g. cited by literature, not
  generated this turn).

---

## Anti-Fabrication Hook

`services/agent-claw/src/core/hooks/anti-fabrication.ts`:

- **Trigger**: every `post_tool` dispatch.
- **Action**: extracts `fact_id` UUIDs from output via three known
  shapes:
  1. `output.facts[].fact_id` (query_kg shape)
  2. `output.surfaced_fact_ids[]` (expand_reaction_context)
  3. `output.contradictions[].fact_ids[]` (check_contradictions)
- The hook **NEVER throws** (line 95-97 swallows; line 17-18 documents
  the contract). It only writes to `ctx.scratchpad.seenFactIds`.
- The DENIAL counterpart lives elsewhere: tools like
  `propose_hypothesis` and `synthesize_insights` consult
  `ctx.seenFactIds` and reject claims that cite IDs not in the set.
- **Test coverage**: `hooks-anti-fabrication.test.ts` covers 7 cases
  including all three shapes, accumulation, malformed output, no
  facts. **Solid.**
- **False-positive risk**: low — the hook only WRITES to seenFactIds.
  Tools that downstream-reject must do their own type checking.

---

## Compact-Window Hook

`services/agent-claw/src/core/hooks/compact-window.ts`:

- Phase 3 change (line 1-16): the harness itself gates the dispatch
  on `budget.shouldCompact()`, so by the time the hook runs the
  trigger decision is already made. The hook **always** performs
  compaction.
- Forwards `options.signal` to the compactor (line 66) — the audit
  M11 fix from the prior round. Confirmed.
- The compactor (in `compactor.ts`) calls Haiku (the LiteLLM
  provider). Failure path: if Haiku throws, the hook re-throws — the
  dispatch's catch arm at `lifecycle.ts:250-269` will treat this as a
  non-pre_tool failure (since `pre_compact !== pre_tool`), log
  `event: hook_failed`, and continue. **The compaction does not
  happen, the messages array is unchanged, and the next turn sees
  the un-compacted window** — the budget then trips again.
- **Risk**: a persistent Haiku outage causes the hook to fail every
  turn but the loop continues to consume tokens. There is no fallback
  truncation. The `compact-window-signal.test.ts` covers the abort
  path; there is no test for "Haiku errors but the harness continues."
  **P3** — recommend adding a fallback truncate-by-token-count when
  the Haiku call fails.

---

## Sub-Agent Spawner

`services/agent-claw/src/core/sub-agent.ts`:

- **Lifecycle inheritance**: parent's process-wide `Lifecycle` (line 84-89,
  154-158). Every YAML-registered hook fires for sub-agent turns —
  this is correct per CLAUDE.md "Lifecycle is a process-wide singleton".
- **Scratchpad**: fresh per sub-agent (line 119-132 — own seenFactIds,
  own scratchpad Map). Parent sees only the citations the sub-agent
  returns explicitly. **Good isolation.**
- **Token budget**: separate, capped (line 161-165). Parent's budget
  is unaffected by sub-agent spend at the per-turn level — a known
  trade. The aggregate at the route level is currently invisible.
- **Permission posture**: NO. `dispatch_sub_agent.ts:67` builds
  `SubAgentDeps` but does not propagate any `PermissionOptions`.
  Sub-agents run with no resolver. **P2 — documented in Executive
  Summary.**
- **Recursion depth**: NOT explicitly bounded. Implicit limit comes
  from `SUB_AGENT_TOOL_SUBSETS` not including `dispatch_sub_agent` in
  any of the three subsets (chemist/analyst/reader). A future
  contributor who adds it triggers unbounded recursion. **P2 —
  explicit `depth` counter recommended.**

---

## Session-End Hook

`hooks/session_end` is declared at the type level (`HookPoint` enum at
`core/types.ts:358`), but no YAML and no built-in registrar exists.
`chained-harness.ts:368` actively dispatches `session_end` at end of a
chain — so the dispatch fires into a 0-handler bucket. CLAUDE.md
"Harness Primitives" table says "(declared; no built-ins yet)" — this
is by design, but it means several useful end-of-session signals (final
audit row, optimizer notification, paperclip teardown) have no attach
point.

**Recommendation (P2)**: ship a no-op `session-end.yaml` + matching
registrar so operators can swap in a real handler the same way they
can with `session-events`. This is symmetric with how Phase 4B handled
`session_start`.

---

## Findings (Full Appendix)

### F-12.1 (P1) — `permissionMode: "enforce"` only on SSE chat

See "Permission Posture per Call Site" table above for the seven
non-enforced surfaces. Resolver wiring:

```ts
// services/agent-claw/src/core/step.ts:120-139
if (permissions) {
  const permResult = await resolveDecision({ tool, input, ctx, options: permissions, lifecycle });
  if (permResult.decision === "deny" || permResult.decision === "defer") { … return … }
}
```

`permissions` is undefined on every site except `chat.ts:405`, so the
entire `if (permissions) { … }` block is skipped, the resolver never
fires, and `permission_policies` rows have no effect.

`buildAgent.run` (used by chat-non-streaming) is the load-bearing
miss: even after wiring `permissions:` into `chat.ts`, the
`stream: false` branch dispatches via `agent.run` which never accepts
a `permissions` arg.

### F-12.2 (P1) — Skill loader ignores `maturity` and `shadow_until`

```ts
// skills.ts:353-356
const result = await withSystemContext(pool, (client) =>
  client.query(`SELECT id::text AS id, name, prompt_md, kind, version
                  FROM skill_library
                 WHERE active = true
                 ORDER BY name, version DESC`),
);
```

Both columns exist in the schema; loader doesn't read them.

### F-12.3 (P1) — `inchikey_from_smiles` referenced but not registered

Two skills (`library_design_planner`, `qm_pipeline_planner`) declare
the tool. Neither
`grep -E "registerBuiltin\(.inchikey_from_smiles." services/agent-claw/src/bootstrap/dependencies.ts`
nor any other registration site matches. When either skill is active
the LLM is told the tool exists; calls fail at dispatch with "model
requested unknown tool" (per step.ts:101-104).

### F-12.4 (P1) — Resolver "ask" silently downgraded at pre_tool

The resolver's `enforce` mode can return `ask` (resolver.ts:118-127).
`step.ts:163-173` logs and continues:

```ts
if (preResult.decision === "ask" || preResult.decision === "defer") {
  getLogger("agent-claw.harness.step").warn(
    { event: "permission_decision_unhandled", … },
    "permission decision treated as allow (Phase 6 resolver pending)",
  );
}
```

Currently no `permission_policies` row in the seed uses `ask`, so the
gap is theoretical — but the moment an operator sets one, it silently
becomes `allow`.

### F-12.5 (P2) — Permission hook is misleadingly always-on

`hooks/permission.yaml` declares `enabled: true`. The hook
implementation reads from the policy loader. But the hook is only
**dispatched** when `resolver.dispatch("permission_request", …)` runs,
which happens only when a route passes `permissions:` to runHarness.
Reading the YAML alone leads operators to believe DB-backed
permissions are active globally.

### F-12.6 (P2) — Stale "no production route does today" comment

`core/types.ts:287` and `core/permissions/resolver.ts:4-8` both
contradict `chat.ts:405`. Update to reflect that SSE chat does pass
`permissions:`.

### F-12.7 (P2) — `session_end` dispatched but no built-in registrar

`chained-harness.ts:368` fires `session_end`; the lifecycle dispatch
hits a zero-bucket. End-of-chain telemetry has no built-in attach
point.

### F-12.8 (P2) — Sub-agent recursion guard implicit

No explicit depth counter. Safety relies on
`SUB_AGENT_TOOL_SUBSETS` not exposing `dispatch_sub_agent`.

### F-12.9 (P2) — Sub-agent inherits no permissions

`dispatch_sub_agent.ts:67` doesn't forward any `PermissionOptions` to
`spawnSubAgent`. Sub-agent harnesses run permission-resolver-free.

### F-12.10 (P2) — `tag-maturity` swallows DB errors

```ts
// tag-maturity.ts:103-127
try {
  await withUserContext(pool, payload.ctx.userEntraId, async (client) => { … });
} catch {
  // Non-fatal: stamping still works, just no DB persistence.
}
```

No log, no metric. An artifact INSERT that fails silently breaks the
foundation-citation-guard chain (the artifact ID never enters
`maturityMap`).

### F-12.11 (P2) — `redact-secrets` ignores AbortSignal

Acceptable today (5MB input cap bounds CPU), but worth a comment
or short-circuit on `_options?.signal?.aborted`.

### F-12.12 (P2) — Deep-research route may leak un-redacted question via SSE

`deep-research.ts:213` builds a sink with `makeSseSink(reply, …)`. The
sink's default `onAwaitingUserInput` (sse-sink.ts:55-72) writes the
question raw. `chat.ts:362-370` strips this callback because the
route owns redaction; **DR does NOT.** A SMILES embedded in the
question reaches the wire un-redacted. **P2 — confirm and fix.**

### F-12.13 (P3) — Compactor failure has no fallback

A persistent Haiku outage causes `compact-window` to throw every
turn; the harness logs and proceeds with the un-compacted window.
Token usage continues to rise until budget-exceeded. Recommend
fallback truncate-by-token-count.

### F-12.14 (P3) — `hooks/source-cache.yaml` has unrecognised fields

`tool_id_pattern`, `implementation`, `stale_check_phase` —
documentation-only. Either land them as documented advisory fields in
`HookYaml` or drop from the YAML.

---

## Cross-Reference: Prior Audit (2026-04-29)

### Resolved since prior audit

- **W1.7** (compact-window / source-cache / tag-maturity ignore
  AbortSignal) — **all three fixed**. Confirmed at
  `compact-window.ts:66`, `source-cache.ts:497`, `tag-maturity.ts:151`.
- **W1.5 vs prior audits' "not in any production route"** — actually
  resolved: SSE chat does pass `permissions:`. Three audit reports'
  text now disagrees; this finding documents the actual state.

### Persistent

- **W1.3 / BACKLOG.md:6** — `permissionMode: "enforce"` only on SSE
  chat. F-12.1 above. Visibility raised: 7 surfaces affected, not 5.
- **W1.8** — `promote_workflow_to_tool` sets `active=FALSE` with no
  activation endpoint. Mentioned in the skill-loader-correctness
  section above.

### New regressions / findings from this audit

- **F-12.1** widened: chat-non-streaming + sub-agents are also
  exempt (not just the 5 routes BACKLOG calls out).
- **F-12.2** Skill loader ignores `maturity` and `shadow_until`.
  Phase E features incomplete.
- **F-12.3** `inchikey_from_smiles` orphan in 2 skills.
- **F-12.4** "ask" decision silently downgraded.
- **F-12.5** `hooks/permission.yaml` is misleadingly always-on.
- **F-12.6** Stale "no production route" comments in
  `core/types.ts:287` and `core/permissions/resolver.ts:4-8`.
- **F-12.7** `session_end` dispatched, no registrar.
- **F-12.12** Deep-research SSE may leak un-redacted question.

---

## Verification commands

```bash
# Hook YAML / registrar parity (no orphans):
diff \
  <(ls hooks/*.yaml | xargs -n1 basename | sed 's/\.yaml$//' | sort) \
  <(ls services/agent-claw/src/core/hooks/*.ts | xargs -n1 basename | sed 's/\.ts$//' | sort)

# MIN_EXPECTED_HOOKS gate alignment:
grep -c '^name:' hooks/*.yaml | wc -l   # expect 11
grep -E 'MIN_EXPECTED_HOOKS = ' services/agent-claw/src/bootstrap/start.ts

# Skill tool refs missing from builtin registry:
diff \
  <(grep -hE "^\s*-\s+[a-z_]+\s*$" skills/*/SKILL.md | grep -oE "[a-z_]+" | sort -u) \
  <(grep -E 'registerBuiltin\("[a-z_]+"' services/agent-claw/src/bootstrap/dependencies.ts | grep -oE '"[a-z_]+"' | tr -d '"' | sort -u)

# Routes that pass `permissions:` to harness:
grep -rn "permissions:.*permissionMode" services/agent-claw/src/routes/

# Hooks that read AbortSignal:
grep -nE "options\??\.signal" services/agent-claw/src/core/hooks/*.ts
```

End of report.
