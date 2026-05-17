# ChemClaw Lifecycle Hooks Reference

This document covers the built-in lifecycle hooks registered in the agent harness (`MIN_EXPECTED_HOOKS = 29`; 31 YAML files in `hooks/` with 2 conditionally-registered). Hooks are registered at startup by matching a YAML file in `hooks/` to a `BUILTIN_REGISTRARS` entry in `services/agent-claw/src/core/hook-loader.ts`.

**Decision aggregation:** `deny > defer > ask > allow`. A hook returning `permissionDecision: "deny"` short-circuits subsequent hooks for that phase.

**Timeout:** Each hook has a 60-second per-call timeout (overridable via `timeout_ms:` in the YAML). A timed-out hook logs a warning and returns `{}` — it never blocks the harness.

**Adding a hook:** See [CLAUDE.md](../../CLAUDE.md) "Adding a hook" section. Short version: implementation in `services/agent-claw/src/core/hooks/<name>.ts`, YAML at `hooks/<name>.yaml`, entry in `BUILTIN_REGISTRARS`, bump `MIN_EXPECTED_HOOKS`.

**Note:** `budget-guard` is an exception — it throws `BudgetExceededError` rather than returning `deny`, which the harness catches and converts to a 402 response.

---

### `anti-fabrication`

**Lifecycle phase:** `post_tool`

**Purpose:** Harvests `fact_id` UUIDs from every tool output and accumulates them into `ctx.scratchpad.seenFactIds` (a `Set<string>`). This is the sole writer of the per-turn fact-ID set; tools such as `propose_hypothesis` read it at call time to enforce the hard guard that prevents the model from citing fact IDs it has never seen in the current turn.

**Harvesting paths (in order):**
1. `output.facts[].fact_id` — `query_kg` shape
2. `output.surfaced_fact_ids[]` — `expand_reaction_context` / `check_contradictions` shape
3. `output.contradictions[].fact_ids[]` — `check_contradictions` shape
4. `output.fact_id` (top-level string) — `query_provenance` shape
5. `output.items[]` where `kind == 'fact'` and `fact.fact_id` — `retrieve_related` shape

**Decision output:** Always `{}` (no decision contribution). The hook never throws; harvesting failures are swallowed.

**Configuration:** None. Always enabled.

---

### `apply-skills`

**Lifecycle phase:** `pre_turn`

**Purpose:** Injects the active skill set into each turn before the LLM call. Two actions:
1. Prepends the `prompt.md` bodies of all active skills to the system message.
2. Writes the skill-filtered tool list to `ctx.scratchpad["skillFilteredTools"]`; the route reads this key to override the tool catalog for the turn.

Must run after `init-scratch`.

**Decision output:** Always `{}`.

**Configuration:** Depends on `SkillLoader` (injected at registration). Active skill IDs are tracked in `loader.activeIds`.

---

### `budget-guard`

**Lifecycle phase:** `pre_tool`

**Purpose:** Checks the per-turn token budget before each tool executes. Projects expected usage as `(promptTokensUsed + completionTokensUsed + toolOverhead)` and throws `BudgetExceededError` when the projection would exceed `AGENT_TOKEN_BUDGET`. The error is caught by the harness and emitted as a `budget_exceeded` finish reason with HTTP 402.

**Decision output:** Throws `BudgetExceededError` rather than returning a `deny` decision — this is intentional to preserve the existing 402 error flow. Normal path returns `{}`.

**Configuration (via `ctx.scratchpad.budget`):**

| Field | Type | Description |
|---|---|---|
| `promptTokensUsed` | `number` | Tokens consumed so far in the prompt |
| `completionTokensUsed` | `number` | Tokens consumed in completions |
| `tokenBudget` | `number` | Maximum allowed total (from `AGENT_TOKEN_BUDGET`) |
| `toolOverhead` | `number` (optional) | Per-call estimate; default **500** tokens |

If no budget scratch is present the guard is a no-op.

---

### `compact-window`

**Lifecycle phase:** `pre_compact`

**Purpose:** Fires when `Budget.shouldCompact()` returns true (model-reported usage ≥ `compactionThreshold × maxPromptTokens`). Calls the `compact()` compactor, which replaces the full message window with: system prompt + LLM-generated synopsis + the most recent N messages (default 3). The `messages` array is mutated in-place so the harness sees the compacted window on the next iteration.

**Decision output:** Always `{}`.

**Configuration (injected deps):**

| Field | Default | Description |
|---|---|---|
| `tokenBudget` | `AGENT_TOKEN_BUDGET` | Full token budget forwarded to the compactor |
| `triggerFraction` | `0.60` | Kept for parity with Budget; the harness gates dispatch |
| `keepRecent` | `3` | Number of recent messages to preserve verbatim |

The hook also reads `payload.custom_instructions` (set by the `/compact` slash verb) and forwards it to the summarizer as steering.

---

### `compute-result-writer`

**Lifecycle phase:** `post_tool` (order: 110)

**Purpose:** Persists chemistry prediction tool outputs to the `compute_results` canonical table (keyed by `(tool_id, input_hash, nce_project_id, model_id)`). On conflict, refreshes `payload`, `tool_confidence`, and sets `valid_to = NULL` (cache refresh). The `compute_result_observed` trigger in `db/init/56_compute_results.sql` fires a downstream ingestion event.

**Activation conditions:**
- Tool must have a non-null `result_schema_id` in the registry (covers `propose_retrosynthesis`, `predict_yield_with_uq`, `predict_molecular_property`, `elucidate_mechanism`, `qm_single_point`, `qm_crest_screen`, `assess_applicability_domain`, `identify_unknown_from_ms`, `predict_reaction_yield`, `statistical_analyze`, `generate_focused_library`)
- `ctx.nceProjectId` must be non-null
- Feature flag `chemistry.compute_results.persist` must be `true` (default: **false**)

**Confidence extraction logic:** `total_score` from top retrosynthesis route → `ensemble_mean / 100` from yield prediction → averaged `ensemble_mean` from predictions array → `null`.

**Decision output:** Always `{}`. Failures are logged at `warn` and swallowed.

---

### `kg-conclusion-buffer`

**Lifecycle phase:** `post_tool` (order: 120)

**Purpose:** Part of Phase 6 Universal Knowledge Accumulation. Buffers chemistry tool outputs in `ctx.scratchpad["kg_conclusion_inputs"]` for the companion `kg-conclusion-extractor` post-turn hook. Only buffers non-empty object/array outputs from chemistry-domain tools (matched against a pattern covering retrosynthesis, yield prediction, property prediction, mechanism elucidation, QM, statistical analysis, and related tools). Internal builtins and null/empty/string outputs are skipped.

**Decision output:** Always `{}`. Errors swallowed at `warn` level.

**Configuration:** Feature-gated by `kg.conclusion_extraction.enabled` (default: **false**). The YAML `condition` block also gates registration — enabling the flag without a code deploy is supported.

---

### `kg-conclusion-extractor`

**Lifecycle phase:** `post_turn` (order: 90)

**Purpose:** Part of Phase 6 Universal Knowledge Accumulation. Reads and clears `ctx.scratchpad["kg_conclusion_inputs"]`, calls the LLM (`role=judge`, non-streaming) with a curated system prompt, and inserts ABSTRACTED facts into the `facts` table. Each inserted fact has:
- `derivation_class = 'ABSTRACTED'`
- `derivation_depth = 0`
- `confidence` capped at **0.70**
- `extractor_name = 'kg-conclusion-extractor'`

For each inserted fact, emits one `extracted_fact` ingestion event so the investigation_scorer and interpreter projectors can process it.

**Decision output:** Always `{}`. Errors swallowed at `warn` level; buffer is always cleared regardless of success.

**Configuration:** Same `kg.conclusion_extraction.enabled` flag as `kg-conclusion-buffer`. System prompt instructs the LLM to return a JSON array of 0–5 fact drafts with specific confidence bands: 0.60–0.70 for strong multi-tool inference, 0.40–0.59 for plausible, 0.20–0.39 for speculative.

---

### `detect-mcp-leakage`

**Lifecycle phase:** `post_tool`

**Purpose:** Defense-in-depth tripwire that scans source-system MCP responses for sensitive pattern matches (SMILES, compound codes, NCE project IDs, emails) without mutating the output. Uses the same `redactString` primitive as `redact-secrets` but only counts matches and logs them. Fires only for tools matching `/^(query_eln|fetch_eln|query_lims|fetch_lims|query_instrument|fetch_instrument)_/`. Outputs with string content > 1 MB are skipped.

**Decision output:** Always `{}`. The hook is a passive tripwire; it never alters or denies.

**Observability:** Emits a structured log line with `event: "mcp_response_pattern_detected"`, `tool_id`, `counts` (pattern-name → match count), and `total_matches`. Operators watch Loki for this event.

---

### `fact-id-consistency-guard`

**Lifecycle phase:** `post_tool`

**Purpose:** Validates that every fact_id declared in `output.surfaced_fact_ids[]` is also present in the same output's concrete fact-bearing fields (`facts[]`, `items[]` of `kind='fact'`, or `contradictions[].fact_ids[]`). A mismatch suggests a forged tool fabricated the declaration. On mismatch, emits a structured `warn` log line with `event: "fact_id_consistency_violation"`, `tool_id`, `missing_count`, and `sample_missing` (up to 3 IDs).

**Decision output:** Always `{}`. Never throws or denies — observation-only as a low-risk first step (review 2026-05-10 §2.6). A future denying variant is noted in the backlog.

---

### `foundation-citation-guard`

**Lifecycle phase:** `pre_tool`

**Purpose:** Rejects a tool call that declares `maturity_tier: "FOUNDATION"` in its input while citing at least one artifact ID that is tagged `EXPLORATORY` in `ctx.scratchpad.artifactMaturity`. This prevents the agent from promoting weak evidence to FOUNDATION-tier claims without going through the proper promotion path.

**Decision output:** Returns `permissionDecision: "deny"` with a human-readable reason when the violation is detected. Returns `{}` when no maturity mismatch is found, when no `artifactMaturity` map is present (no-op), or when the input does not declare `FOUNDATION`.

**Checked input keys:** `cited_fact_ids`, `fact_ids`, `evidence_fact_ids`, `source_ids`.

---

### `init-scratch`

**Lifecycle phase:** `pre_turn`

**Purpose:** Initializes per-turn scratch state before any LLM call. Creates an empty `Set<string>` at `ctx.scratchpad["seenFactIds"]`. Must be registered before `anti-fabrication` so the set exists before fact-ID harvesting begins.

**Decision output:** Always `{}`.

---

### Lifecycle telemetry hooks (cluster F)

Nine lifecycle points that were previously dispatched but had no built-in registrar. Each emits a single structured log line and returns `{}` with no decision contribution.

| Hook name | Lifecycle phase | Log level | Key fields logged |
|---|---|---|---|
| `session-end-telemetry` | `session_end` | `info` | `sessionId`, `finishReason` |
| `user-prompt-submit-telemetry` | `user_prompt_submit` | `info` | `sessionId`, `promptLength` (never logs prompt body) |
| `post-tool-failure-telemetry` | `post_tool_failure` | `warn` | `toolId`, `durationMs`, `err` |
| `post-tool-batch-telemetry` | `post_tool_batch` | `info` | `batchSize`, `toolIds[]` |
| `subagent-start-telemetry` | `subagent_start` | `info` | `type`, `maxSteps`, `maxTokens` |
| `subagent-stop-telemetry` | `subagent_stop` | `info` | `type`, `finishReason`, `stepsUsed`, `durationMs`, `promptTokens`, `completionTokens` |
| `task-created-telemetry` | `task_created` | `info` | `todoId`, `ordering` |
| `task-completed-telemetry` | `task_completed` | `info` | `todoId` |
| `post-compact-telemetry` | `post_compact` | `info` | `trigger`, `preTokens`, `postTokens`, `shrinkRatio` |

To replace any of these with a custom sink (Langfuse, OTel, Slack), swap the registrar in `BUILTIN_REGISTRARS` — the YAML name and `lifecycle.on()` shape stay identical.

---

### `loop-detector`

**Lifecycle phase:** `pre_tool`

**Purpose:** Detects when the model calls the same tool with substantially the same arguments repeatedly within a sliding window of 10 recent calls. Uses a SHA-256 hash of the normalized input (keys sorted recursively, cycles handled, `Date` objects stabilized to ISO string).

**Thresholds:**

| Threshold | Value | Effect |
|---|---|---|
| `STUCK_THRESHOLD` | 3 | Appends a `LoopWarning` to `ctx.scratchpad["loop_warnings"]` (observe only) |
| `HARD_DENY_THRESHOLD` | 5 | Returns `permissionDecision: "deny"` forcing the model off the broken path |

**Decision output:** `permissionDecision: "deny"` at hard-deny threshold. `{}` otherwise.

**Scratchpad keys written:**
- `recent_tool_calls` — sliding window of `{toolId, argsHash, ts}` entries (max 10)
- `loop_warnings` — list of `{toolId, argsHash, occurrences, firstSeen, lastSeen}` (max 20)

---

### `permission`

**Lifecycle phase:** `permission_request`

**Purpose:** Reads `permission_policies` from the DB via `PermissionPolicyLoader` (60s TTL cache) and returns a `permissionDecision` when a policy matches the current tool call. Matching logic uses `tool_pattern` (with trailing wildcard support) and an optional `argument_pattern` against the JSON-serialized input. Org/project scoping is supported when `ctx.orgId` / `ctx.nceProjectId` are populated.

**Decision output:** `permissionDecision: "deny" | "ask" | "allow"` with `permissionDecisionReason` when a policy matches. `{}` when no match or when the loader singleton is not set up (graceful degradation for unit tests).

---

### `redact-secrets`

**Lifecycle phase:** `post_turn`

**Purpose:** Defense-in-depth scrub of the assistant's final text (`payload.finalText`) before it leaves the harness. Applies the same length-bounded `redactString` patterns as `redact-tool-output`. Replacements are logged to `ctx.scratchpad["redact_log"]` for observability. Runs from the harness's `finally` block so it fires on error paths too.

**Patterns redacted:** reaction SMILES (`\S{1,400}>\S{0,400}>\S{1,400}`), SMILES tokens (bond-grammar heuristic), email addresses, NCE project IDs (`NCE-\d{1,6}`), compound codes (`CMP-\d{4,8}`).

**Decision output:** Always `{}`.

---

### `redact-tool-output`

**Lifecycle phase:** `post_tool` (order: 200 — runs LAST)

**Purpose:** Scrubs every string leaf in source-system tool outputs before they enter the next-turn LLM context. Scoped to tools matching `/^(query|fetch)_(eln|lims|instrument)_/` only. Chemistry compute tools are deliberately excluded because the LLM must reason over their SMILES output. Registered at order 200 so earlier post-tool hooks (`anti-fabrication`, `tag-maturity`, `source-cache`, `detect-mcp-leakage`, `fact-id-consistency-guard`) see the unredacted output first.

**Decision output:** Always `{}`. Idempotent — re-running on already-redacted text is a no-op.

---

### `scheduled-substance-gate`

**Lifecycle phase:** `pre_tool`

**Purpose:** Scans every string leaf in tool inputs for verbatim canonical SMILES or InChIKeys matching the curated CWC Schedule-1 / DEA Schedule-I / EAR Cat 1C list in `src/data/scheduled-substances.ts`. Guards the entire tool catalog uniformly without per-tool wiring.

**Decision output:**
- `severity = "deny"` → `permissionDecision: "deny"` (blocks the tool call)
- `severity = "ask"` → `permissionDecision: "ask"` (requires attestation)

**Limitations (verbatim match only):** Does not catch tautomers, salts, isotopologues, alternate Kekulé forms, or stereoisomer drops. Substructure matching against class SMARTS is a follow-up item tracked in `BACKLOG.md` (H0.9).

**Tenant override path:** A `permission_policies` row with `decision="allow"` and the substance's identifier in `argument_pattern` can re-allow the substance for tenants holding the appropriate regulatory registration. The `permission` hook's policy-loader runs before `pre_tool` dispatch and will short-circuit this gate.

**Scan bounds:** Max recursion depth 16; max string count per input 5,000; strings longer than 1,024 characters are skipped (SMILES / InChIKeys are short).

---

### `session-events`

**Lifecycle phase:** `session_start`

**Purpose:** No-op stub that serves as the canonical attachment surface for session-start telemetry (Langfuse session, OTel span, app log). Fires on both `source="create"` (new session) and `source="resume"` paths in `chat.ts`. Replace the implementation in `BUILTIN_REGISTRARS` to emit custom telemetry without altering the harness.

**Decision output:** Always `{}`.

---

### `session-sandbox-close`

**Lifecycle phase:** `session_end`

**Purpose:** Closes any per-session E2B sandbox cached on the scratchpad by `acquireSessionSandbox`. Fires on all session-end paths (including `awaiting_user_input`, `finished_max_steps`, `stop`, `cancelled`) so idle sessions release their E2B slot immediately rather than holding it until process exit. Failures are logged and dropped; the sandbox lingers on the E2B side until its template TTL expires.

**Decision output:** Always `{}`. If the sandbox client was not injected at bootstrap (no forged tools), the hook is a no-op.

---

### `source-cache`

**Lifecycle phase:** `post_tool`

**Purpose:** After any source-system tool call (`query_eln_*`, `fetch_eln_*`, `query_lims_*`, `fetch_lims_*`, `query_instrument_*`, `fetch_instrument_*`), extracts structured facts from the tool output and inserts `ingestion_events` rows with `event_type='source_fact_observed'`. The `kg_source_cache` projector converts these into Neo4j `:Fact` nodes with temporal provenance.

**Recognized output shapes:**
- `ElnEntry` (top-level or in `items[]`): yield, purity, temperature, solvent, reaction time, catalyst, base, equivalents extracted from `fields_jsonb` or legacy `fields`
- `CanonicalReactionDetail` / `CanonicalReaction`: `mean_yield`, `ofat_count`; `ofat_children` recursed as ELN entries
- `Sample`: `purity_pct`, `amount_mg`, nested `results[].metric + value_num`
- `LogsDataset` (top-level, in `datasets[]`, or in `dataset`): `MEASURED_FROM_SAMPLE`, `HAS_INSTRUMENT_KIND`, `total_area`, `area_pct`, `retention_time_min`, `purity_pct`

**Decision output:** Always `{}`. Respects the per-dispatch `AbortSignal` — if the signal is already aborted the DB write is skipped.

---

### `tag-maturity`

**Lifecycle phase:** `post_tool`

**Purpose:** Stamps `maturity: "EXPLORATORY"` on all structured (non-primitive, non-array) tool outputs. For a specific subset of tool IDs (`ARTIFACT_TOOL_IDS`: `propose_hypothesis`, `synthesize_insights`, `draft_section`, `mark_research_done`, `dispatch_sub_agent`, `check_contradictions`, `compute_confidence_ensemble`, `propose_retrosynthesis`, `predict_reaction_yield`, `predict_yield_with_uq`, `predict_molecular_property`, `identify_unknown_from_ms`, `elucidate_mechanism`), also inserts an `artifacts` row and records the artifact ID in `ctx.scratchpad["artifactMaturity"]`.

For outputs carrying their own IDs (`fact_id`, `hypothesis_id`, `report_id`), those IDs are also added to the maturity map.

**Decision output:** Always `{}`. DB write is skipped if the `AbortSignal` has fired.

---

### `tool-invocation-emitter`

**Lifecycle phase:** `post_tool` and `post_tool_failure` (order: 80)

**Purpose:** Part of Phase 0 Universal Knowledge Accumulation. Emits one `tool_invocation_complete` ingestion event per non-internal tool call carrying the redacted args, result, `tool_name`, `user_entra_id`, `project_id`, `result_schema_id`, `duration_ms`, `ok` flag, and `error` string. The `tool_result_extractor` projector consumes these events.

**Decision output:** Always `{}`. Errors swallowed at `warn` level.

**Configuration:** Feature-gated by `kg.auto_extraction.enabled` (default: **false**). The YAML `condition` block also gates registration. Internal builtins (`is_internal == true`) are always skipped; unregistered tool IDs are treated as non-internal (errs on the side of emitting).

---

### `wiki-human-block-guard`

**Lifecycle phase:** `pre_tool`

**Purpose:** Denies any `upsert_article` call whose `body_md` contains a `<!-- human:begin ... -->` marker. These markers are reserved for human curators editing via `PATCH /api/articles/:id`; an agent authoring them would forge "human-authored" content with a fake owner. This is defense-in-depth alongside the check in `upsert_article`'s `execute()` method (which also refuses to overwrite pages with `has_human_edits = true`).

**Decision output:** `permissionDecision: "deny"` with a specific error message directing the agent to use `request_article` instead. Returns `{}` for all other tool IDs or when no body is present.

---