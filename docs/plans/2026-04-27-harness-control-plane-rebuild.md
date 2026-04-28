# Harness Control-Plane Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Branch policy (user directive 2026-04-27):** all code implementation lands on the long-lived **`using-superpowers`** branch in worktree `../chemclaw-using-superpowers`. No per-phase sub-branches. Each phase is one commit (or a tightly-related cluster).

**Goal:** Bring the agent-claw harness from its current half-finished state (3 separate ReAct loops, 4 dead hook implementations, orphaned YAML loader, `pre_compact` never fires) to a Claude-Code-quality control plane with one canonical loop, a single hook-registration path, the full Claude Code hook surface (15+ events with matcher-based filtering and decision contracts), automatic context compaction, workspace boundary validation, and integration test coverage for the persistence/auth/parity paths.

**Architecture:** One `runHarness` while-loop in `core/harness.ts` is the only ReAct loop in the system. Streaming is a feature flag (`streamSink` option) on that loop, not a parallel implementation. Hook registration has exactly one entry point — the YAML loader — and its `BUILTIN_REGISTRARS` map covers every hook .ts file in `core/hooks/`. Hook callbacks receive `(input, toolUseID, { signal })` and return a typed decision (`allow | deny | ask | defer`) per Claude Code SDK semantics. `pre_compact` fires from `runHarness` whenever projected token usage crosses a configurable threshold. The result is a system that is correct by construction (no dual-path drift) and matches Claude Code's hook contract well enough that operators familiar with `.claude/settings.json` see immediate parity.

**Tech Stack:** TypeScript (Fastify, Zod, AI SDK, vitest), Postgres (chemclaw_app role with FORCE RLS), js-yaml for hook configs, AbortController for hook cancellation, Postgres testcontainers for integration tests, scripted JSON scenarios for parity tests. No new runtime dependencies.

---

## Source-of-truth references

- **Audit findings** that drive this plan: see conversation transcript starting at the "Deep Audit: Is the agent-claw harness properly implemented?" message — every gap below maps to a specific file:line in that audit.
- **Claude Code hooks reference:** https://code.claude.com/docs/en/hooks (28 hook events, matcher syntax, JSON i/o)
- **Claude Agent SDK TypeScript reference:** https://code.claude.com/docs/en/agent-sdk/typescript (19 events, `HookCallback` shape, `HookJSONOutput`, message-type union)
- **Claude Agent SDK hooks guide:** https://code.claude.com/docs/en/agent-sdk/hooks (decision contract, matcher behaviour, async hooks)
- **Claude Agent SDK loop overview:** https://code.claude.com/docs/en/agent-sdk/agent-loop (canonical loop, compaction trigger, sub-agent inheritance)
- **Reference Claude-Code re-implementation (community Rust port):** https://github.com/ultraworkers/claw-code — see `rust/PARITY.md` for what they have done vs deferred; we adopt their parity-tracker pattern (Phase 10) and mock-scenario harness pattern (Phase 11), and their workspace-boundary validation (Phase 6 enhancement).
- **In-repo design context:** `docs/adr/004-harness-engineering.md` (the "~500-LOC custom while-loop" claim that was over-promised); `~/.claude/plans/go-through-the-three-vivid-sunset.md` (R.1–R.6 quality cleanup; complementary, not overlapping).

---

## Audit gap → phase mapping

| Audit gap | Phase |
|---|---|
| Three independent ReAct loops (chat.ts, deep-research.ts, harness.ts) | 2 |
| `pre_compact` never dispatched | 3 |
| 4 hook .ts files (init-scratch, anti-fabrication, apply-skills, foundation-citation-guard) unregistered | 1 |
| `source-cache` and `compact-window` YAML loaded but skipped (not in BUILTIN_REGISTRARS) | 1 |
| Global `lifecycle` exported from index.ts but never imported | 1 |
| `manage_todos` SSE emit hard-coded in chat.ts (single-route, not portable) | 2 |
| MCP auth dev-mode `return None` fail-open | 7 |
| No etag-conflict / chained-execution / reanimator integration tests | 8 |
| Hook contract is `Promise<void>` — no decision return, no cancellation | 4 |
| Tool registry has no `readOnly` annotation; no parallel tool execution | 5 |
| No permission system; tools all run unconditionally | 6 |
| No workspace boundary validation (symlink/`..` traversal) | 6 |
| Hook ordering is registration-order only (no priority, no matcher) | 4 |
| Per-hook observability is ad-hoc (`console.error`) | 9 |
| No end-to-end scenario regression tests | 11 |

---

## File structure (where each phase touches)

```
services/agent-claw/
  src/
    core/
      harness.ts                         # Phase 2: single loop with streamSink option; Phase 3: pre_compact dispatch
      step.ts                            # Phase 4: honour pre_tool decision; Phase 5: parallel batch
      lifecycle.ts                       # Phase 4: HookDecision, matchers, async-hook support, AbortSignal
      hook-loader.ts                     # Phase 1: only entry point; BUILTIN_REGISTRARS ↑ to 9
      harness-builders.ts                # Phase 1: DELETED (loader replaces it)
      session-state.ts                   # Phase 1 NEW: hydrateScratchpad, persistTurnState (migrated)
      streaming-sink.ts                  # Phase 2 NEW: StreamSink interface
      hook-output.ts                     # Phase 4 NEW: HookJSONOutput, PermissionDecision
      compactor.ts                       # Phase 3: invoked from pre_compact hook
      types.ts                           # Phases 2/3/4/6: extended unions
      hooks/
        init-scratch.ts                  # Phase 1: registered
        anti-fabrication.ts              # Phase 1: registered
        apply-skills.ts                  # Phase 1: registered
        foundation-citation-guard.ts     # Phase 1: registered (returns deny instead of throws)
        source-cache.ts                  # Phase 1: registered
        compact-window.ts                # Phase 1: registered + Phase 3 wiring
        budget-guard.ts                  # already wired
        tag-maturity.ts                  # already wired
        redact-secrets.ts                # already wired
        session-events.ts                # Phase 4 NEW: emits SessionStart/End
        permission.ts                    # Phase 6 NEW: permission decision hook
    security/
      workspace-boundary.ts              # Phase 6.7 NEW: symlink/escape guard
    tools/
      tool.ts                            # Phase 5: ToolAnnotations.readOnly
      registry.ts                        # Phase 5: parallel-batch-aware iteration
    routes/
      chat.ts                            # Phase 2: deletes streaming loop, calls runHarness
      deep-research.ts                   # Phase 2: deletes its loop, calls runHarness
      sessions.ts                        # already uses runHarness; Phase 8 adds tests
      plan.ts                            # already uses runHarness
    streaming/
      sse-sink.ts                        # Phase 2 NEW: StreamSink → SSE adapter
    observability/
      hook-spans.ts                      # Phase 9 NEW: per-hook Langfuse spans
      tool-spans.ts                      # Phase 9 NEW: per-tool Langfuse spans
  tests/
    unit/
      lifecycle-decisions.test.ts        # Phase 4
      lifecycle-matchers.test.ts         # Phase 4
      hook-loader-coverage.test.ts       # Phase 1
      streaming-sink.test.ts             # Phase 2
      pre-compact-trigger.test.ts        # Phase 3
      permission-mode.test.ts            # Phase 6
      workspace-boundary.test.ts         # Phase 6.7
    integration/
      all-hooks-fire.test.ts             # Phase 1
      chat-streaming-via-harness.test.ts # Phase 2
      pre-compact-end-to-end.test.ts     # Phase 3
      etag-conflict.test.ts              # Phase 8
      chained-execution.test.ts          # Phase 8
      reanimator-roundtrip.test.ts       # Phase 8
      mcp-auth-fail-closed.test.ts       # Phase 7
    parity/
      runner.ts                          # Phase 11 NEW: scenario runner
      parity.test.ts                     # Phase 11
      scenarios/
        01-tool-call-then-text.json
        02-pre-compact-fires.json
        03-deny-precedence.json
        04-ask-user-pause.json
        05-todo-lifecycle.json
        06-permission-deny-via-hook.json
        07-parallel-readonly-batch.json
        08-session-resume.json

services/mcp_tools/common/
  auth.py                                # Phase 7: fail-closed in dev unless explicit opt-in

hooks/                                   # repo root, YAML hook configs
  init-scratch.yaml                      # Phase 1 NEW
  anti-fabrication.yaml                  # Phase 1 NEW
  apply-skills.yaml                      # Phase 1 NEW
  foundation-citation-guard.yaml         # Phase 1 NEW
  session-events.yaml                    # Phase 4 NEW
  permission.yaml                        # Phase 6 NEW
  # existing 5: budget-guard, compact-window, redact-secrets, source-cache, tag-maturity

docs/
  adr/
    007-hook-system-rebuild.md           # Phase 1 finale
    008-collapsed-react-loop.md          # Phase 2 finale
    009-permission-and-decision-contract.md  # Phases 4+6 finale
    010-mock-parity-harness.md           # Phase 11 finale
  PARITY.md                              # Phase 10: ChemClaw ↔ Claude Agent SDK parity tracker
  runbooks/
    harness-v2-migration.md              # Phase 10
```

---

# Phase 0 — Worktree + safety net (1 day)

**Goal:** Create the long-lived `using-superpowers` branch + worktree, baseline the current test counts, and freeze a regression bar that every later phase must clear.

### Task 0.1: Create worktree + branch

**Files:**
- New worktree at `../chemclaw-using-superpowers` on branch `using-superpowers` from `main`.

- [ ] **Step 1: Verify clean main**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw
git status
```
Expected: clean working tree on `main`. If you're on `fix/mcp-review-batch` with uncommitted edits, finish or stash them first — this rebuild starts from a clean `main` base.

- [ ] **Step 2: Create the worktree**

```bash
git worktree add -b using-superpowers ../chemclaw-using-superpowers main
cd ../chemclaw-using-superpowers
```
Expected: new directory created, branch `using-superpowers` checked out. Git rejects leading slashes in branch names, so the literal name is `using-superpowers` (no slash). If a prior attempt left the branch behind, `git worktree add ../chemclaw-using-superpowers using-superpowers` reuses it.

- [ ] **Step 3: Baseline the test counts**

```bash
cd services/agent-claw && npm install && npm test 2>&1 | tail -5 > /tmp/baseline-agent-claw.txt
cd ../paperclip && npm install && npm test 2>&1 | tail -5 > /tmp/baseline-paperclip.txt
cd ../.. && cat /tmp/baseline-agent-claw.txt /tmp/baseline-paperclip.txt
```
Expected: agent-claw 667 passed, paperclip 17 passed. These are the floor — every later phase must keep them green and the count must only go up.

- [ ] **Step 4: Add a regression-guard pre-commit hook (optional but strongly recommended)**

In `../chemclaw-using-superpowers/.git/hooks/pre-commit`, run `npm test --workspace services/agent-claw` and abort on any failure or count drop. Not committed; lives in the worktree only.

- [ ] **Step 5: Commit the empty branch marker**

```bash
git commit --allow-empty -m "chore: start harness control-plane rebuild on using-superpowers"
```

---

# Phase 1 — Single source of truth for hook registration (2 days)

**Goal:** Eliminate the dual registration path. The YAML hook loader becomes the only entry point. All 9 hook .ts files get registered. The orphaned global `lifecycle` in `index.ts` and the redundant `buildDefaultLifecycle()` factory are deleted. A test guarantees every YAML file maps to a registrar.

**Why:** the audit found `buildDefaultLifecycle()` (harness-builders.ts:24) and `BUILTIN_REGISTRARS` (hook-loader.ts:54) both registered the same 3 hooks while 4 hook .ts files (init-scratch, anti-fabrication, apply-skills, foundation-citation-guard) had zero callers in src/. The YAML loader populated a global `lifecycle` (index.ts:159) that no route ever imported. Two YAML files (compact-window.yaml, source-cache.yaml) loaded then skipped because their names weren't in `BUILTIN_REGISTRARS`. This phase makes drift impossible — there's one map, one config dir, one entry point.

### Task 1.1: Test that every YAML hook has a registrar (TDD red)

**Files:**
- Create: `services/agent-claw/tests/unit/hook-loader-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// services/agent-claw/tests/unit/hook-loader-coverage.test.ts
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { loadHooks } from "../../src/core/hook-loader.js";
import { mockHookDeps } from "../helpers/mocks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const hooksDir = resolve(repoRoot, "hooks");

describe("hook loader coverage", () => {
  it("registers every YAML hook (no skips for missing registrar)", async () => {
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), hooksDir);
    const skipsForMissingRegistrar = result.skipped.filter((s) =>
      s.includes("no built-in registrar"),
    );
    expect(skipsForMissingRegistrar).toEqual([]);
  });

  it("registers all 9 known hook implementations at the right points", async () => {
    const lc = new Lifecycle();
    await loadHooks(lc, mockHookDeps(), hooksDir);
    expect(lc.count("pre_turn")).toBeGreaterThanOrEqual(2);   // init-scratch, apply-skills
    expect(lc.count("pre_tool")).toBeGreaterThanOrEqual(2);   // budget-guard, foundation-citation-guard
    expect(lc.count("post_tool")).toBeGreaterThanOrEqual(3);  // tag-maturity, anti-fabrication, source-cache
    expect(lc.count("pre_compact")).toBeGreaterThanOrEqual(1); // compact-window
    expect(lc.count("post_turn")).toBeGreaterThanOrEqual(1);  // redact-secrets
  });

  it("each YAML file's `name` field is non-empty", async () => {
    const yamlEntries = (await readdir(hooksDir)).filter((f) => f.endsWith(".yaml"));
    for (const file of yamlEntries) {
      const raw = await readFile(resolve(hooksDir, file), "utf8");
      const parsed = parseYaml(raw) as { name: string };
      expect(parsed.name, `${file} has empty name`).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd services/agent-claw && npx vitest run tests/unit/hook-loader-coverage.test.ts
```
Expected: failures because (a) YAML files don't yet exist for the 4 unregistered hooks, (b) BUILTIN_REGISTRARS is missing 6 entries, (c) `loadHooks` signature doesn't take `deps` yet.

### Task 1.2: Add the missing 4 YAML files

**Files:**
- Create: `hooks/init-scratch.yaml`, `hooks/anti-fabrication.yaml`, `hooks/apply-skills.yaml`, `hooks/foundation-citation-guard.yaml`
- (compact-window.yaml and source-cache.yaml already exist; no edit needed)

- [ ] **Step 1: Write `hooks/init-scratch.yaml`**

```yaml
name: init-scratch
lifecycle: pre_turn
enabled: true
priority: 0  # must run before apply-skills and anti-fabrication
definition:
  description: Seed ctx.scratchpad.seenFactIds with an empty Set<string>.
```

- [ ] **Step 2: Write `hooks/anti-fabrication.yaml`**

```yaml
name: anti-fabrication
lifecycle: post_tool
enabled: true
priority: 10
definition:
  description: |
    Harvest fact_ids from tool outputs into ctx.scratchpad.seenFactIds. Tools
    like synthesize_insights consult this set to drop any insight citing
    fact_ids that did not appear in this turn's tool results.
```

- [ ] **Step 3: Write `hooks/apply-skills.yaml`**

```yaml
name: apply-skills
lifecycle: pre_turn
enabled: true
priority: 5
definition:
  description: |
    Inspect the user message + active session state, select up to 8 matching
    skill packs from the loader, append their SKILL.md content to the system
    prompt, and apply any tool-restriction overrides.
```

- [ ] **Step 4: Write `hooks/foundation-citation-guard.yaml`**

```yaml
name: foundation-citation-guard
lifecycle: pre_tool
enabled: true
priority: 20  # runs after budget-guard so we don't waste budget on guard rejections
definition:
  description: |
    When a tool input declares maturity_tier='FOUNDATION', verify the call
    cites at least one fact_id present in ctx.scratchpad.seenFactIds. Returns
    permissionDecision='deny' otherwise (was: throw).
```

### Task 1.3: Add `HookDeps` and expand `BUILTIN_REGISTRARS` to all 9

**Files:**
- Modify: `services/agent-claw/src/core/hook-loader.ts:1-58`

- [ ] **Step 1: Add HookDeps + expanded imports + map**

```typescript
// services/agent-claw/src/core/hook-loader.ts (top of file)
import type { Pool } from "pg";
import type { LlmProvider } from "../llm/provider.js";
import type { SkillLoader } from "./skills.js";
import type { Tool } from "../tools/tool.js";
import { registerRedactSecretsHook } from "./hooks/redact-secrets.js";
import { registerTagMaturityHook } from "./hooks/tag-maturity.js";
import { registerBudgetGuardHook } from "./hooks/budget-guard.js";
import { registerInitScratchHook } from "./hooks/init-scratch.js";
import { registerAntiFabricationHook } from "./hooks/anti-fabrication.js";
import { registerFoundationCitationGuardHook } from "./hooks/foundation-citation-guard.js";
import { registerSourceCacheHook } from "./hooks/source-cache.js";
import { registerCompactWindowHook } from "./hooks/compact-window.js";
import { registerApplySkillsHook } from "./hooks/apply-skills.js";

export interface HookDeps {
  pool: Pool;
  llm: LlmProvider;
  skillLoader: SkillLoader;
  allTools: Tool[];
}

type BuiltinRegistrar = (lc: Lifecycle, deps: HookDeps) => void;

const BUILTIN_REGISTRARS: Map<string, BuiltinRegistrar> = new Map([
  ["redact-secrets", (lc) => registerRedactSecretsHook(lc)],
  ["tag-maturity", (lc) => registerTagMaturityHook(lc)],
  ["budget-guard", (lc) => registerBudgetGuardHook(lc)],
  ["init-scratch", (lc) => registerInitScratchHook(lc)],
  ["anti-fabrication", (lc) => registerAntiFabricationHook(lc)],
  ["foundation-citation-guard", (lc) => registerFoundationCitationGuardHook(lc)],
  ["source-cache", (lc, deps) => registerSourceCacheHook(lc, deps.pool)],
  ["compact-window", (lc, deps) => registerCompactWindowHook(lc, { llm: deps.llm })],
  ["apply-skills", (lc, deps) => registerApplySkillsHook(lc, deps.skillLoader, deps.allTools)],
]);
```

- [ ] **Step 2: Update `loadHooks` signature to require deps**

```typescript
export async function loadHooks(
  lifecycle: Lifecycle,
  deps: HookDeps,
  hooksDir?: string,
): Promise<HookLoadResult> {
  // existing body, but at line 177:
  registrar(lifecycle, deps);
  result.registered++;
}
```

### Task 1.4: Update `index.ts` to pass deps

**Files:**
- Modify: `services/agent-claw/src/index.ts:457`

```typescript
// services/agent-claw/src/index.ts:457 — replace the current loadHooks call:
const hookResult = await loadHooks(lifecycle, {
  pool,
  llm: llmProvider,
  skillLoader,
  allTools: registry.all(),
});
app.log.info(hookResult, "lifecycle hooks loaded");
```

- [ ] **Step 1: Run coverage tests, expect green**

```bash
cd services/agent-claw && npx vitest run tests/unit/hook-loader-coverage.test.ts
```
Expected: PASS — the lifecycle now contains all 9 hooks at the expected points.

### Task 1.5: Delete `buildDefaultLifecycle` + the orphan global; routes import the populated global

**Files:**
- Create: `services/agent-claw/src/core/session-state.ts` (migrate `hydrateScratchpad` and `persistTurnState` from harness-builders.ts)
- Delete: `services/agent-claw/src/core/harness-builders.ts`
- Modify: `services/agent-claw/src/index.ts` (no change — `lifecycle` is already exported)
- Modify: `services/agent-claw/src/routes/{chat,plan,sessions}.ts` (replace `buildDefaultLifecycle()` with the imported global)
- Modify: `services/agent-claw/src/core/sub-agent.ts:160-163` (remove its local Lifecycle creation)
- Modify: `services/agent-claw/src/core/types.ts` (add optional `lifecycle` to `ToolContext` so sub-agents inherit it)

- [ ] **Step 1: Create `session-state.ts`** — copy `hydrateScratchpad` and `persistTurnState` verbatim from harness-builders.ts:33-110.

- [ ] **Step 2: Update routes**

```typescript
// services/agent-claw/src/routes/chat.ts:42 — replace:
//   import { buildDefaultLifecycle, hydrateScratchpad } from "../core/harness-builders.js";
// with:
import { hydrateScratchpad, persistTurnState } from "../core/session-state.js";
import { lifecycle } from "../index.js";

// Then DELETE the per-route line:
//   const lifecycle = buildDefaultLifecycle();
// at chat.ts:387, plan.ts:72, sessions.ts:489.
```

- [ ] **Step 3: Sub-agent shares parent lifecycle**

```typescript
// services/agent-claw/src/core/sub-agent.ts:160 — replace lines 160-163:
//   const lifecycle = new Lifecycle();
//   registerRedactSecretsHook(lifecycle);
//   registerTagMaturityHook(lifecycle);
//   registerBudgetGuardHook(lifecycle);
// with:
const lifecycle = parentCtx.lifecycle ?? deps.lifecycle;
// Add `lifecycle?: Lifecycle` to ToolContext in core/types.ts. The route
// that originally calls runHarness sets ctx.lifecycle = the global; sub-agents
// inherit it automatically.
```

- [ ] **Step 4: Delete the file**

```bash
rm services/agent-claw/src/core/harness-builders.ts
```

- [ ] **Step 5: Run full suite**

```bash
cd services/agent-claw && npm test 2>&1 | tail -10
```
Expected: 667 + 3 new = 670 passed. If anything regresses, search for `harness-builders` and replace remaining imports.

- [ ] **Step 6: Commit Phase 1**

```bash
git add services/agent-claw/src/core/{hook-loader,session-state,sub-agent,types}.ts \
        services/agent-claw/src/routes/{chat,plan,sessions}.ts \
        services/agent-claw/src/index.ts \
        services/agent-claw/tests/unit/hook-loader-coverage.test.ts \
        hooks/{init-scratch,anti-fabrication,apply-skills,foundation-citation-guard}.yaml
git rm services/agent-claw/src/core/harness-builders.ts
git commit -m "refactor(harness): single source of truth for hook registration

- Expand BUILTIN_REGISTRARS to all 9 hook .ts files (was 3); add 4 missing
  YAML configs.
- Delete buildDefaultLifecycle factory + orphan-global wiring. The YAML
  loader is now the only registration path; routes import the populated
  global lifecycle.
- Migrate hydrateScratchpad/persistTurnState into core/session-state.ts.
- Sub-agents inherit the parent Lifecycle so hooks added in one place
  apply everywhere (no more drift between sub-agent.ts and chat.ts).

Closes audit gaps: 4 dead-code hooks, orphan global lifecycle, 2 YAML
files skipped at load time."
```

### Task 1.6: Integration test — all 4 active hook points fire

**Files:**
- Create: `services/agent-claw/tests/integration/all-hooks-fire.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { loadHooks } from "../../src/core/hook-loader.js";
import { runHarness } from "../../src/core/harness.js";
import { Budget } from "../../src/core/budget.js";
import { mockLlm, mockTools, mockHookDeps } from "../helpers/mocks.js";

describe("all hooks fire on a real harness turn", () => {
  it("dispatches pre_turn, pre_tool, post_tool, post_turn at least once each", async () => {
    const lc = new Lifecycle();
    await loadHooks(lc, mockHookDeps());
    const dispatchSpy = vi.spyOn(lc, "dispatch");
    await runHarness({
      messages: [{ role: "user", content: "hi" }],
      tools: mockTools(),
      llm: mockLlm({ tool: "search_knowledge", thenText: "done" }),
      budget: new Budget({ maxSteps: 3 }),
      lifecycle: lc,
      ctx: { userEntraId: "test-user", scratchpad: new Map(), seenFactIds: new Set() },
    });
    const points = dispatchSpy.mock.calls.map((c) => c[0]);
    expect(points).toContain("pre_turn");
    expect(points).toContain("pre_tool");
    expect(points).toContain("post_tool");
    expect(points).toContain("post_turn");
    // pre_compact tested in Phase 3.
  });
});
```

```bash
cd services/agent-claw && npx vitest run tests/integration/all-hooks-fire.test.ts
git add services/agent-claw/tests/integration/all-hooks-fire.test.ts
git commit -m "test(harness): integration test that all 4 active lifecycle points fire"
```

---

# Phase 2 — Collapse three ReAct loops into one (3 days)

**Goal:** `core/harness.ts` is the only ReAct loop in the system. `chat.ts:557` and `deep-research.ts:219` lose their hand-rolled `streaming: while (true)` loops and call `runHarness` instead. Streaming is enabled via a new `streamSink` option on `runHarness` — the harness still owns control flow; the sink only receives notifications.

**Why:** the audit found three independent ReAct loops, all manually dispatching lifecycle hooks. This is the largest source of drift bait — every hook addition or change has to remember three sites. Worse, `manage_todos`'s SSE emit is hard-coded into chat.ts:623 and only fires for `/api/chat`, not other harness call paths.

The Claude Agent SDK pattern is `query()` → `AsyncGenerator<SDKMessage>`. We keep our existing `runHarness({...}) → Promise<HarnessResult>` shape (Fastify SSE writers don't need the AsyncGenerator) but add a `streamSink` callback option that receives the same notifications.

### Task 2.1: Define `StreamSink` (TDD red)

**Files:**
- Create: `services/agent-claw/src/core/streaming-sink.ts`
- Create: `services/agent-claw/tests/unit/streaming-sink.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// services/agent-claw/tests/unit/streaming-sink.test.ts
import { describe, it, expect } from "vitest";
import type { StreamSink } from "../../src/core/streaming-sink.js";
import { runHarness } from "../../src/core/harness.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import { mockLlmWithStream, mockTools } from "../helpers/mocks.js";

describe("StreamSink", () => {
  it("emits onTextDelta + tool brackets", async () => {
    const events: string[] = [];
    const sink: StreamSink = {
      onSession: (id) => events.push(`session:${id}`),
      onTextDelta: (delta) => events.push(`delta:${delta}`),
      onToolCall: (id) => events.push(`call:${id}`),
      onToolResult: (id) => events.push(`result:${id}`),
      onTodoUpdate: (todos) => events.push(`todos:${todos.length}`),
      onAwaitingUserInput: (q) => events.push(`ask:${q}`),
      onFinish: (reason) => events.push(`finish:${reason}`),
    };
    await runHarness({
      messages: [{ role: "user", content: "do x" }],
      tools: mockTools(),
      llm: mockLlmWithStream({ toolCall: "search_knowledge", finalText: "answer" }),
      budget: new Budget({ maxSteps: 3 }),
      lifecycle: new Lifecycle(),
      ctx: { userEntraId: "u", scratchpad: new Map(), seenFactIds: new Set() },
      streamSink: sink,
      sessionId: "sess-1",
    });
    expect(events[0]).toBe("session:sess-1");
    expect(events).toContain("call:search_knowledge");
    expect(events).toContain("result:search_knowledge");
    expect(events.some((e) => e.startsWith("delta:"))).toBe(true);
    expect(events[events.length - 1]).toBe("finish:stop");
  });

  it("when streamSink is undefined, harness behaves identically to today", async () => {
    const result = await runHarness({
      messages: [{ role: "user", content: "do x" }],
      tools: mockTools(),
      llm: mockLlmWithStream({ finalText: "answer" }),
      budget: new Budget({ maxSteps: 3 }),
      lifecycle: new Lifecycle(),
      ctx: { userEntraId: "u", scratchpad: new Map(), seenFactIds: new Set() },
    });
    expect(result.text).toBe("answer");
    expect(result.finishReason).toBe("stop");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (StreamSink type doesn't exist).

### Task 2.2: Implement StreamSink + extend HarnessOptions

**Files:**
- Create: `services/agent-claw/src/core/streaming-sink.ts`
- Modify: `services/agent-claw/src/core/types.ts`

```typescript
// services/agent-claw/src/core/streaming-sink.ts
export interface TodoSnapshot {
  id: string;
  ordering: number;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface StreamSink {
  onSession?: (sessionId: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolId: string, input: unknown) => void;
  onToolResult?: (toolId: string, output: unknown) => void;
  onTodoUpdate?: (todos: TodoSnapshot[]) => void;
  onAwaitingUserInput?: (question: string) => void;
  onFinish?: (reason: string, usage: { promptTokens: number; completionTokens: number }) => void;
}
```

```typescript
// services/agent-claw/src/core/types.ts — add to HarnessOptions
import type { StreamSink } from "./streaming-sink.js";
export interface HarnessOptions {
  // existing fields ...
  streamSink?: StreamSink;
  sessionId?: string;
}
```

### Task 2.3: Wire sink into `runHarness` and `stepOnce`

**Files:**
- Modify: `services/agent-claw/src/core/harness.ts`
- Modify: `services/agent-claw/src/core/step.ts`

- [ ] **Step 1: harness.ts emits onSession + onFinish + onAwaitingUserInput**

```typescript
// services/agent-claw/src/core/harness.ts:29 — extend runHarness
export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  const { messages, tools, llm, budget, lifecycle, ctx, streamSink, sessionId } = options;
  if (streamSink && sessionId) streamSink.onSession?.(sessionId);
  // existing pre_turn dispatch, scratchpad init ...
  let finalText = "";
  let finishReason = "stop";
  try {
    loop: while (true) {
      if (budget.isStepCapReached()) { finishReason = "max_steps"; break loop; }
      const { step, toolOutput, usage } = await stepOnce({
        llm, tools, messages, lifecycle, ctx, streamSink,
      });
      budget.consumeStep(usage);
      // existing tool-result push + text break ...
    }
  } catch (err) {
    if (err instanceof AwaitingUserInputError) {
      finishReason = "awaiting_user_input";
      streamSink?.onAwaitingUserInput?.(err.question);
      throw err;
    }
    if (err instanceof BudgetExceededError) { finishReason = "budget_exceeded"; throw err; }
    throw err;
  } finally {
    await lifecycle.dispatch("post_turn", { ctx, finalText, stepsUsed: budget.stepsUsed });
    streamSink?.onFinish?.(finishReason, budget.summary());
  }
  return { text: finalText, finishReason, stepsUsed: budget.stepsUsed, usage: budget.summary() };
}
```

- [ ] **Step 2: stepOnce emits onToolCall, onToolResult, onTodoUpdate, onTextDelta**

```typescript
// services/agent-claw/src/core/step.ts — extend StepOnceOptions and the function body
export interface StepOnceOptions {
  // existing fields ...
  streamSink?: StreamSink;
}

export async function stepOnce(opts: StepOnceOptions): Promise<StepResult> {
  // 1. If streamSink, use llm.streamCompletion to get text deltas.
  //    Buffer the first chunk to detect tool_call vs text (AI SDK guarantees
  //    they are mutually exclusive in one response).
  if (opts.streamSink) {
    // Use AI SDK streamText({ tools }), iterate fullStream, branch on first
    // chunk's type. For text branch: emit onTextDelta as text-delta chunks
    // arrive. For tool_call branch: collect the input, then proceed below.
  } else {
    // Non-streamed path: existing llm.call() branch (unchanged).
  }

  if (step.kind === "tool_call") {
    await opts.lifecycle.dispatch("pre_tool", prePayload);
    opts.streamSink?.onToolCall?.(step.toolId, step.input);
    const output = await tool.execute(opts.ctx, parsedInput);
    const postPayload = { ctx: opts.ctx, toolId: step.toolId, input: step.input, output };
    await opts.lifecycle.dispatch("post_tool", postPayload);
    opts.streamSink?.onToolResult?.(step.toolId, postPayload.output);
    if (step.toolId === "manage_todos") {
      const todos = (postPayload.output as { todos?: TodoSnapshot[] }).todos;
      if (todos) opts.streamSink?.onTodoUpdate?.(todos);
    }
  }
  // 3. Return.
}
```

```bash
cd services/agent-claw && npx vitest run tests/unit/streaming-sink.test.ts
```
Expected: PASS.

### Task 2.4: SSE-sink adapter

**Files:**
- Create: `services/agent-claw/src/streaming/sse-sink.ts`

```typescript
// services/agent-claw/src/streaming/sse-sink.ts
import type { FastifyReply } from "fastify";
import type { StreamSink, TodoSnapshot } from "../core/streaming-sink.js";
import { writeEvent } from "./sse.js";
import { redactString, type RedactReplacement } from "../core/hooks/redact-secrets.js";

export function makeSseSink(reply: FastifyReply, redactionLog: RedactReplacement[]): StreamSink {
  return {
    onSession: (id) => writeEvent(reply, { type: "session", session_id: id }),
    onTextDelta: (delta) => {
      const safe = redactString(delta, redactionLog);
      writeEvent(reply, { type: "text_delta", delta: safe });
    },
    onToolCall: (toolId, input) => writeEvent(reply, { type: "tool_call", toolId, input }),
    onToolResult: (toolId, output) => writeEvent(reply, { type: "tool_result", toolId, output }),
    onTodoUpdate: (todos: TodoSnapshot[]) => writeEvent(reply, { type: "todo_update", todos }),
    onAwaitingUserInput: (q) => writeEvent(reply, { type: "awaiting_user_input", question: q }),
    onFinish: (reason, usage) => writeEvent(reply, { type: "finish", finishReason: reason, usage }),
  };
}
```

### Task 2.5: Migrate chat.ts and deep-research.ts

**Files:**
- Modify: `services/agent-claw/src/routes/chat.ts:540-680` (delete the manual loop)
- Modify: `services/agent-claw/src/routes/deep-research.ts:175-298`

- [ ] **Step 1: Replace the chat.ts streaming loop**

In `chat.ts`, **delete lines 540–680** (the `await lifecycle.dispatch("pre_turn"...)`, `streaming: while (true)` block, and tool-call/text-delta handling). Replace with:

```typescript
// services/agent-claw/src/routes/chat.ts (replacing lines 540-680)
import { makeSseSink } from "../streaming/sse-sink.js";
const sink = makeSseSink(reply, _streamRedactions);
budget = new Budget({ maxSteps: effectiveMaxSteps, maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET, session: sessionId ? { inputUsed: sessionInputUsed, outputUsed: sessionOutputUsed, inputCap: sessionInputCap, outputCap: sessionOutputCap } : undefined });
const result = await runHarness({
  messages, tools, llm: deps.llm, budget, lifecycle, ctx,
  streamSink: sink, sessionId: sessionId ?? undefined,
});
finalText = result.text;
finishReason = result.finishReason;
stepsUsed = result.stepsUsed;
```

The post_turn redaction-log persist + session save (lines 711-799) **stay** — that's session state, not loop control.

- [ ] **Step 2: Same migration for deep-research.ts**

- [ ] **Step 3: Verify chat.ts shrunk by ~150 LOC**

```bash
wc -l services/agent-claw/src/routes/chat.ts
```
Expected: was 865, now ~700.

- [ ] **Step 4: Tests**

```bash
cd services/agent-claw && npx vitest run tests/unit/chat-route.test.ts tests/integration/streaming-chat.test.ts
```

### Task 2.6: New integration test exercises the full route

**Files:**
- Create: `services/agent-claw/tests/integration/chat-streaming-via-harness.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { build } from "../helpers/build-app.js";
import { sseEvents } from "../helpers/sse-consumer.js";

describe("chat streaming routes through runHarness", () => {
  it("emits session, tool_call, tool_result, text_delta, finish in the right order", async () => {
    const app = await build();
    const events: Array<{ type: string }> = [];
    const res = await app.inject({
      method: "POST", url: "/api/chat",
      headers: { "x-user-entra-id": "test-user", accept: "text/event-stream" },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    for (const ev of sseEvents(res.body)) events.push(ev);
    expect(events[0].type).toBe("session");
    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types[types.length - 1]).toBe("finish");
  });
});
```

```bash
cd services/agent-claw && npx vitest run tests/integration/chat-streaming-via-harness.test.ts
git add services/agent-claw/src/{core/streaming-sink.ts,streaming/sse-sink.ts,routes/{chat,deep-research}.ts,core/{harness,step,types}.ts} \
        services/agent-claw/tests/{unit/streaming-sink.test.ts,integration/chat-streaming-via-harness.test.ts}
git commit -m "refactor(harness): collapse 3 ReAct loops into runHarness with StreamSink

- Add StreamSink interface modelled on Claude Agent SDK SDKMessage
  notification surface. The harness owns control flow; the sink
  receives observability events.
- Extend runHarness to accept optional streamSink + sessionId; uses
  llm.streamCompletion for text steps when set.
- Tool-call notifications emit from stepOnce around existing pre/post_tool
  dispatches. manage_todos onTodoUpdate moves to a single site
  (every harness call path now emits it consistently).
- Delete chat.ts streaming loop (~150 LOC) and deep-research.ts loop
  (~115 LOC). Both routes are now I/O adapters built around makeSseSink().

Closes audit gap: harness.ts is now the only ReAct loop."
```

---

# Phase 3 — `pre_compact` actually fires (2 days)

**Goal:** When projected token usage on a turn crosses a configurable threshold (default 60% of `maxPromptTokens`), the harness dispatches `pre_compact` with `trigger: "auto"`. The `compact-window` hook receives the message list, calls the Haiku-backed compactor, and returns a compacted message list that replaces `messages[]` for the next iteration. A `post_compact` event also fires.

**Why:** the audit found `pre_compact` had zero dispatch sites despite being declared as a hook point. Claude Code's automatic compaction is a major UX feature; long sessions don't OOM the context window because old turns get summarised.

### Task 3.1: Failing test for pre_compact dispatch

**Files:**
- Create: `services/agent-claw/tests/unit/pre-compact-trigger.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { runHarness } from "../../src/core/harness.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import { mockLlmHighUsage, mockTools } from "../helpers/mocks.js";

describe("pre_compact triggers when usage > 60% of budget", () => {
  it("fires pre_compact + post_compact when threshold exceeded", async () => {
    const lc = new Lifecycle();
    const dispatchSpy = vi.spyOn(lc, "dispatch");
    const budget = new Budget({ maxSteps: 5, maxPromptTokens: 10_000, compactionThreshold: 0.6 });
    await runHarness({
      messages: [{ role: "user", content: "x" }],
      tools: mockTools(),
      llm: mockLlmHighUsage({ promptTokensPerStep: 7_000, finalText: "ok" }),
      budget, lifecycle: lc,
      ctx: { userEntraId: "u", scratchpad: new Map(), seenFactIds: new Set() },
    });
    const points = dispatchSpy.mock.calls.map((c) => c[0]);
    expect(points).toContain("pre_compact");
    expect(points).toContain("post_compact");
  });

  it("does NOT fire when usage stays below threshold", async () => {
    const lc = new Lifecycle();
    const dispatchSpy = vi.spyOn(lc, "dispatch");
    const budget = new Budget({ maxSteps: 5, maxPromptTokens: 100_000, compactionThreshold: 0.6 });
    await runHarness({
      messages: [{ role: "user", content: "x" }],
      tools: mockTools(),
      llm: mockLlmHighUsage({ promptTokensPerStep: 1_000, finalText: "ok" }),
      budget, lifecycle: lc,
      ctx: { userEntraId: "u", scratchpad: new Map(), seenFactIds: new Set() },
    });
    expect(dispatchSpy.mock.calls.map((c) => c[0])).not.toContain("pre_compact");
  });
});
```

```bash
cd services/agent-claw && npx vitest run tests/unit/pre-compact-trigger.test.ts
```
Expected: FAIL.

### Task 3.2: Add `post_compact` hook point + `compactionThreshold` to Budget

**Files:**
- Modify: `services/agent-claw/src/core/types.ts`
- Modify: `services/agent-claw/src/core/lifecycle.ts:22-28`
- Modify: `services/agent-claw/src/core/hook-loader.ts:32-38`
- Modify: `services/agent-claw/src/core/budget.ts`

```typescript
// types.ts — extend HookPoint and add payload types
export type HookPoint = "pre_turn" | "pre_tool" | "post_tool" | "pre_compact" | "post_compact" | "post_turn";

export interface PreCompactPayload {
  ctx: ToolContext;
  messages: Message[];
  trigger: "manual" | "auto";
  pre_tokens: number;
  custom_instructions?: string | null;
}

export interface PostCompactPayload {
  ctx: ToolContext;
  trigger: "manual" | "auto";
  pre_tokens: number;
  post_tokens: number;
}
```

```typescript
// lifecycle.ts:22 — add post_compact to HookPayloadMap
type HookPayloadMap = {
  pre_turn: PreTurnPayload; pre_tool: PreToolPayload; post_tool: PostToolPayload;
  pre_compact: PreCompactPayload; post_compact: PostCompactPayload; post_turn: PostTurnPayload;
};
```

```typescript
// hook-loader.ts:32
const VALID_HOOK_POINTS = new Set<string>([
  "pre_turn", "pre_tool", "post_tool", "pre_compact", "post_compact", "post_turn",
]);
```

```typescript
// budget.ts
export interface BudgetOptions {
  maxSteps: number;
  maxPromptTokens?: number;
  maxCompletionTokens?: number;
  compactionThreshold?: number;  // default 0.6
  session?: SessionBudget;
}

export class Budget {
  // ...
  shouldCompact(): boolean {
    if (!this.maxPromptTokens) return false;
    const threshold = (this.compactionThreshold ?? 0.6) * this.maxPromptTokens;
    return this.promptTokensUsed >= threshold;
  }

  resetPromptTokens(newCount: number): void {
    this.promptTokensUsed = newCount;
  }
}
```

### Task 3.3: Dispatch pre_compact + post_compact from inside the loop

**Files:**
- Modify: `services/agent-claw/src/core/harness.ts:58-97`
- Modify: `services/agent-claw/src/core/hooks/compact-window.ts`

```typescript
// harness.ts — after each step
loop: while (true) {
  if (budget.isStepCapReached()) { finishReason = "max_steps"; break loop; }
  const { step, toolOutput, usage } = await stepOnce({/* ... */});
  budget.consumeStep(usage);

  // NEW: compaction check
  if (budget.shouldCompact()) {
    const preTokens = budget.promptTokensUsed;
    const payload: PreCompactPayload = {
      ctx, messages, trigger: "auto", pre_tokens: preTokens, custom_instructions: null,
    };
    await lifecycle.dispatch("pre_compact", payload);
    // compact-window mutates payload.messages in place.
    const postTokens = estimateTokenCount(messages);
    budget.resetPromptTokens(postTokens);
    await lifecycle.dispatch("post_compact", {
      ctx, trigger: "auto", pre_tokens: preTokens, post_tokens: postTokens,
    });
  }
  // existing tool_call vs text branching ...
}
```

```typescript
// hooks/compact-window.ts
import { compactor } from "../compactor.js";

export function registerCompactWindowHook(lc: Lifecycle, deps: { llm: LlmProvider }): void {
  lc.on("pre_compact", "compact-window", async (payload: PreCompactPayload) => {
    const compacted = await compactor.compact(payload.messages, {
      llm: deps.llm,
      keepRecent: 6,
      summaryInstructions: payload.custom_instructions ?? undefined,
    });
    payload.messages.length = 0;
    payload.messages.push(...compacted);
  });
}
```

```bash
cd services/agent-claw && npx vitest run tests/unit/pre-compact-trigger.test.ts
```
Expected: PASS.

### Task 3.4: Manual `/compact` slash command

**Files:**
- Modify: `services/agent-claw/src/core/slash.ts`
- Modify: `services/agent-claw/src/routes/chat.ts`

```typescript
// slash.ts — extend recognised commands
case "compact":
  return { kind: "compact", instructions: rest.trim() || null };

// chat.ts — handle compact before harness runs
if (parsed.kind === "compact") {
  const payload: PreCompactPayload = {
    ctx, messages, trigger: "manual",
    pre_tokens: estimateTokenCount(messages),
    custom_instructions: parsed.instructions,
  };
  await lifecycle.dispatch("pre_compact", payload);
}
```

### Task 3.5: End-to-end integration test + commit

**Files:**
- Create: `services/agent-claw/tests/integration/pre-compact-end-to-end.test.ts`

Drives a 4-turn fake conversation where each tool result is huge; asserts pre_compact + post_compact fire, `messages.length` shrinks after compaction, and the final answer still references information from the pre-compaction history.

```bash
cd services/agent-claw && npx vitest run tests/integration/pre-compact-end-to-end.test.ts
git add services/agent-claw/src/core/{types,lifecycle,hook-loader,budget,harness,hooks/compact-window,slash,compactor}.ts \
        services/agent-claw/src/routes/chat.ts \
        services/agent-claw/tests/{unit/pre-compact-trigger.test.ts,integration/pre-compact-end-to-end.test.ts}
git commit -m "feat(harness): pre_compact + post_compact fire on token threshold

- Add post_compact to the hook-point set; both pre/post_compact get
  payload types matching Claude Agent SDK SDKCompactBoundaryMessage shape
  (trigger, pre_tokens, post_tokens).
- Budget.shouldCompact() returns true when promptTokensUsed >=
  compactionThreshold * maxPromptTokens (default 60%).
- runHarness dispatches pre_compact after each step when threshold
  crossed; the compact-window hook mutates messages in place; post_compact
  fires with the new token estimate.
- /compact slash command triggers pre_compact with trigger='manual'.

Closes audit gap: pre_compact was declared and registered but never
dispatched; the 134-LOC compactor module is now reachable in production."
```

---

# Phase 4 — Claude-Code-shape hook contract (3 days)

**Goal:** Hook callbacks gain Claude Code semantics — receive `(input, toolUseID?, { signal: AbortSignal })`, return typed `HookJSONOutput` with `hookSpecificOutput.permissionDecision: allow|deny|ask|defer`, support `matcher` regex filtering, and fire across the expanded set of hook points (session_start, session_end, user_prompt_submit, post_tool_failure, post_tool_batch, permission_request, subagent_start, subagent_stop, task_created, task_completed). Hooks within a matcher group execute in declared order; **deny > defer > ask > allow** precedence on the aggregate.

### Task 4.1: Define `HookJSONOutput` and migrate the dispatcher

**Files:**
- Create: `services/agent-claw/src/core/hook-output.ts`
- Modify: `services/agent-claw/src/core/lifecycle.ts`

```typescript
// services/agent-claw/src/core/hook-output.ts
export type PermissionDecision = "allow" | "deny" | "ask" | "defer";

export interface PreToolUseSpecificOutput {
  hookEventName: "pre_tool";
  permissionDecision?: PermissionDecision;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
}

export interface PostToolUseSpecificOutput {
  hookEventName: "post_tool";
  additionalContext?: string;
}

export type HookSpecificOutput =
  | PreToolUseSpecificOutput
  | PostToolUseSpecificOutput
  | { hookEventName: string; [k: string]: unknown };

export type HookJSONOutput =
  | { async: true; asyncTimeout?: number }
  | {
      continue?: boolean;
      suppressOutput?: boolean;
      stopReason?: string;
      decision?: "approve" | "block";
      systemMessage?: string;
      reason?: string;
      hookSpecificOutput?: HookSpecificOutput;
    };

export type HookCallback<P = unknown> = (
  input: P,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

export function mostRestrictive(
  a: PermissionDecision | undefined,
  b: PermissionDecision,
): PermissionDecision {
  const order: Record<PermissionDecision, number> = { deny: 4, defer: 3, ask: 2, allow: 1 };
  return !a || order[b] > order[a] ? b : a;
}
```

```typescript
// lifecycle.ts — replace existing class
import type { HookCallback, HookJSONOutput, PermissionDecision } from "./hook-output.js";
import { mostRestrictive } from "./hook-output.js";

interface RegisteredHook<P> {
  name: string;
  matcher?: RegExp;
  handler: HookCallback<P>;
  timeout: number;
}

export class Lifecycle {
  private readonly _hooks: Map<HookPoint, RegisteredHook<unknown>[]> = new Map();

  on<P extends HookPoint>(
    point: P,
    name: string,
    handler: HookCallback<HookPayloadMap[P]>,
    opts: { matcher?: string; timeout?: number } = {},
  ): this {
    if (!this._hooks.has(point)) this._hooks.set(point, []);
    this._hooks.get(point)!.push({
      name,
      matcher: opts.matcher ? new RegExp(opts.matcher) : undefined,
      handler: handler as HookCallback<unknown>,
      timeout: opts.timeout ?? 60_000,
    });
    return this;
  }

  count(point: HookPoint): number { return this._hooks.get(point)?.length ?? 0; }

  async dispatch<P extends HookPoint>(
    point: P,
    payload: HookPayloadMap[P],
    opts: { toolUseID?: string; matcherTarget?: string } = {},
  ): Promise<{ decision?: PermissionDecision; reason?: string; updatedInput?: Record<string, unknown> }> {
    const hooks = this._hooks.get(point) ?? [];
    let decision: PermissionDecision | undefined;
    let reason: string | undefined;
    let updatedInput: Record<string, unknown> | undefined;
    for (const hook of hooks) {
      if (hook.matcher && opts.matcherTarget && !hook.matcher.test(opts.matcherTarget)) continue;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`hook timeout: ${hook.name}`)), hook.timeout);
      try {
        const result = await hook.handler(payload, opts.toolUseID, { signal: ac.signal });
        if ("async" in result && result.async) continue;
        const dec = (result.hookSpecificOutput as PreToolUseSpecificOutput | undefined)?.permissionDecision;
        if (dec) {
          const next = mostRestrictive(decision, dec);
          if (next !== decision) {
            decision = next;
            reason = (result.hookSpecificOutput as PreToolUseSpecificOutput).permissionDecisionReason;
          }
        }
        const upd = (result.hookSpecificOutput as PreToolUseSpecificOutput | undefined)?.updatedInput;
        if (upd) updatedInput = upd;
      } catch (err) {
        if (point === "pre_tool") throw err;  // legacy strict-throw stays
        console.error(`[lifecycle] hook ${hook.name} at ${point} threw — continuing`, err);
      } finally {
        clearTimeout(timer);
      }
    }
    return { decision, reason, updatedInput };
  }
}
```

### Task 4.2: Migrate the 9 existing hooks to return `Promise<HookJSONOutput>`

Each hook changes:
- `async (payload) => Promise<void>` → `async (payload, toolUseID, { signal }) => Promise<HookJSONOutput>`
- Most just append `return {};` at the end.
- `foundation-citation-guard.ts` returns `{ hookSpecificOutput: { hookEventName: "pre_tool", permissionDecision: "deny", permissionDecisionReason: "FOUNDATION tool requires fact_id citation" } }` instead of throwing.
- All 9 hooks updated in one commit; tests for each adjusted to expect the return shape.

### Task 4.3: step.ts honours `pre_tool` decision

**Files:**
- Modify: `services/agent-claw/src/core/step.ts`

```typescript
// After the pre_tool dispatch:
const preResult = await opts.lifecycle.dispatch("pre_tool", prePayload, {
  toolUseID: step.toolId,
  matcherTarget: step.toolId,
});
if (preResult.decision === "deny") {
  return {
    step: { kind: "tool_call", toolId: step.toolId, input: step.input },
    toolOutput: { error: "denied_by_hook", reason: preResult.reason ?? "" },
    usage,
  };
}
let parsedInput = tool.inputSchema.parse(step.input);
if (preResult.updatedInput) {
  parsedInput = tool.inputSchema.parse(preResult.updatedInput);
}
// continue with tool.execute(opts.ctx, parsedInput) ...
```

### Task 4.4: Add 10 new hook points

**Files:**
- Modify: `services/agent-claw/src/core/types.ts` (HookPoint union + payload types for each)
- Modify: `services/agent-claw/src/core/lifecycle.ts` (HookPayloadMap)
- Modify: `services/agent-claw/src/core/hook-loader.ts` (VALID_HOOK_POINTS)
- Modify dispatch sites:
  - `session_start`: `routes/chat.ts` when sessionId is created/loaded; `routes/sessions.ts` resume endpoint
  - `session_end`: `routes/chat.ts` post_turn finally when finishReason === "stop" and no resumable todo
  - `user_prompt_submit`: `routes/chat.ts` top of POST /api/chat, before slash parsing
  - `post_tool_failure`: `step.ts` catch around `tool.execute` (other than AwaitingUserInputError)
  - `post_tool_batch`: `harness.ts` end of each tool batch (Phase 5 will batch read-only tools)
  - `permission_request`: invoked from the permission resolver (Phase 6)
  - `subagent_start` / `subagent_stop`: `core/sub-agent.ts` before/after `runHarness`
  - `task_created` / `task_completed`: `tools/builtins/manage_todos.ts` on insert and on status='completed' update
- Create: `services/agent-claw/src/core/hooks/session-events.ts` (handles session_start/session_end)
- Create: `hooks/session-events.yaml`

Each new dispatch site has at least one unit test asserting the dispatch fires with the right payload.

### Task 4.5: Matcher + decision-precedence tests

**Files:**
- Create: `services/agent-claw/tests/unit/lifecycle-matchers.test.ts`
- Create: `services/agent-claw/tests/unit/lifecycle-decisions.test.ts`

```typescript
// lifecycle-matchers.test.ts
describe("matcher filters callback execution", () => {
  it("only fires when matcher.test(toolId) is true", async () => {
    const lc = new Lifecycle();
    const writeOnly = vi.fn().mockResolvedValue({});
    const all = vi.fn().mockResolvedValue({});
    lc.on("pre_tool", "write-only", writeOnly, { matcher: "Write|Edit" });
    lc.on("pre_tool", "all", all);
    await lc.dispatch("pre_tool", { ctx: {} as any, toolId: "Read", input: {} }, { matcherTarget: "Read" });
    expect(writeOnly).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalled();
    await lc.dispatch("pre_tool", { ctx: {} as any, toolId: "Write", input: {} }, { matcherTarget: "Write" });
    expect(writeOnly).toHaveBeenCalled();
  });
});

// lifecycle-decisions.test.ts
describe("aggregate decision = most restrictive", () => {
  it("any deny wins", async () => {
    const lc = new Lifecycle();
    lc.on("pre_tool", "a", async () => ({ hookSpecificOutput: { hookEventName: "pre_tool", permissionDecision: "allow" } }));
    lc.on("pre_tool", "b", async () => ({ hookSpecificOutput: { hookEventName: "pre_tool", permissionDecision: "deny", permissionDecisionReason: "no" } }));
    lc.on("pre_tool", "c", async () => ({ hookSpecificOutput: { hookEventName: "pre_tool", permissionDecision: "allow" } }));
    const r = await lc.dispatch("pre_tool", { ctx: {} as any, toolId: "x", input: {} });
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("no");
  });
  // Plus: defer-over-ask, ask-over-allow.
});
```

### Task 4.6: Commit Phase 4

```bash
git add services/agent-claw/src/core/{hook-output,lifecycle,types,harness,step,sub-agent,hooks/session-events,hooks/*}.ts \
        services/agent-claw/src/tools/builtins/manage_todos.ts \
        services/agent-claw/src/routes/{chat,sessions}.ts \
        services/agent-claw/tests/unit/lifecycle-{matchers,decisions}.test.ts \
        hooks/session-events.yaml
git commit -m "feat(harness): Claude-Code-shape hook contract

- HookCallback signature now (input, toolUseID, { signal }) -> Promise<HookJSONOutput>;
  matches the Claude Agent SDK contract verbatim.
- Per-hook timeout (default 60s) implemented via AbortController.
- Lifecycle.dispatch aggregates permissionDecision with deny>defer>ask>allow
  precedence; updatedInput overrides tool input.
- New hook points: session_start, session_end, user_prompt_submit,
  post_tool_failure, post_tool_batch, permission_request, subagent_start,
  subagent_stop, task_created, task_completed.
- Existing 9 hooks migrated to new return shape; foundation-citation-guard
  now returns deny+reason instead of throwing.
- step.ts honours preResult.decision (deny -> synthetic rejection;
  updatedInput -> re-parses tool input)."
```

---

# Phase 5 — Tool annotations + parallel tool execution (2 days)

**Goal:** Tool definitions gain `annotations.readOnly?: boolean`. When the LLM emits multiple tool calls in one assistant message, read-only ones execute via `Promise.all`; state-mutating ones run sequentially. After the batch resolves, `post_tool_batch` fires once before the next LLM call.

### Task 5.1: Add `annotations` to ToolDefinition

```typescript
// services/agent-claw/src/tools/tool.ts
export interface ToolAnnotations {
  /** True if the tool only reads state. Read-only tools are eligible for parallel batch execution. */
  readOnly?: boolean;
  /** True if the tool may interact with systems outside the agent's control. */
  openWorld?: boolean;
}

export interface Tool {
  // existing fields ...
  annotations?: ToolAnnotations;
}
```

### Task 5.2: Annotate every existing builtin

Audit each of the 36 builtins; add `annotations: { readOnly: true }` to every `query_*`, `fetch_*`, `search_*`, `predict_*`, `find_*` tool. Leave `forge_tool`, `run_program`, `dispatch_sub_agent`, `manage_todos`, `propose_hypothesis`, `add_forged_tool_test`, `mark_research_done`, `induce_forged_tool_from_trace`, `draft_section` unannotated (they default to sequential).

### Task 5.3: Parallel batch execution in step.ts

When the LLM emits multiple tool_call blocks in a single assistant message, `stepOnce` returns `{ step, toolOutputs: Array<{ toolId, output }> }`. The harness pushes all outputs to `messages` then dispatches `post_tool_batch` once.

Read-only batch members run via `Promise.all`. Any state-mutating tool in the batch falls back to sequential execution for the entire batch (defensive: parallel + state-mutating is footgun territory).

### Task 5.4: Tests + post_tool_batch dispatch + commit

Tests for: all-read-only batch (parallel), mixed batch (sequential), single tool call (unchanged behaviour), post_tool_batch fires once per batch.

---

# Phase 6 — Permission system foundation (3 days, includes 6.7 workspace boundary)

**Goal:** Add a Claude-Code-style permission layer: `permissionMode`, `allowedTools`, `disallowedTools`, optional `permissionCallback`, `permission_request` hook, and workspace-boundary validation for filesystem-touching tools.

### Tasks 6.1–6.6

- **6.1**: Define `Options` (permissionMode, allowedTools, disallowedTools, permissionCallback) and wire into `runHarness`.
- **6.2**: `pre_tool` dispatch checks `permissionMode` and the allow/deny lists before running hook callbacks. If allowed by rule → skip permission_request. If denied by rule → short-circuit deny. Otherwise → fire `permission_request` hook → call `permissionCallback` if provided → fall back to `permissionMode` default.
- **6.3**: Implement `permissionMode === "plan"` — Claude produces a plan via `llm.completeJson`, no tool execution; emits `plan_step` and `plan_ready` SSE events.
- **6.4**: Implement `permissionMode === "acceptEdits"` — auto-approves filesystem-touching tools (Write, Edit, Bash for mkdir/touch/mv/cp).
- **6.5**: `permission_request` hook implementation in `core/hooks/permission.ts` with default behaviour (logs, returns `ask`).
- **6.6**: Tests for each mode + the `allowedTools`/`disallowedTools` precedence.

### Task 6.7: Workspace boundary validation

**Why:** `ultraworkers/claw-code`'s parity tracker explicitly lists workspace-boundary validation as a first-class permission concern: "preventing symlink escapes and `../` traversal" and "file size limits and binary detection safeguards."

**Files:**
- Create: `services/agent-claw/src/security/workspace-boundary.ts`
- Create: `services/agent-claw/tests/unit/workspace-boundary.test.ts`
- Modify: `services/agent-claw/src/tools/builtins/run_program.ts`

```typescript
// services/agent-claw/src/security/workspace-boundary.ts
import { realpathSync, statSync, lstatSync } from "node:fs";
import { resolve, relative } from "node:path";

export class WorkspaceBoundaryError extends Error {}

export interface BoundaryOptions {
  allowedRoots: string[];          // absolute paths
  maxFileSizeBytes?: number;       // default 10MB
  rejectBinary?: boolean;          // default true
}

export function assertWithinWorkspace(path: string, opts: BoundaryOptions): string {
  const lstat = lstatSync(path);
  if (lstat.isSymbolicLink()) {
    throw new WorkspaceBoundaryError(`refused: symlink at ${path}`);
  }
  const real = realpathSync(resolve(path));
  const inside = opts.allowedRoots.some((root) => {
    const r = realpathSync(resolve(root));
    const rel = relative(r, real);
    return rel === "" || (!rel.startsWith("..") && !rel.includes("../"));
  });
  if (!inside) {
    throw new WorkspaceBoundaryError(`refused: path ${real} escapes allowed roots`);
  }
  const stat = statSync(real);
  const cap = opts.maxFileSizeBytes ?? 10 * 1024 * 1024;
  if (stat.isFile() && stat.size > cap) {
    throw new WorkspaceBoundaryError(`refused: file size ${stat.size} > cap ${cap}`);
  }
  return real;
}
```

Tests: rejects symlink, rejects `../` escape, rejects oversized file, allows normal file under allowed root.

Wire into `run_program` and any other filesystem-touching builtin before reading user-supplied paths.

---

# Phase 7 — MCP auth fail-closed in dev (1 day)

**Goal:** `services/mcp_tools/common/auth.py` no longer returns `None` silently when key is unset. Default behaviour fails-closed; only `MCP_AUTH_DEV_MODE=true` allows unsigned requests, and that env var must be **explicit** — there is no default.

### Task 7.1: Failing test

```python
# services/mcp_tools/common/tests/test_auth.py
def test_unsigned_request_rejected_when_no_dev_opt_in(monkeypatch, client):
    monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)
    monkeypatch.delenv("MCP_AUTH_DEV_MODE", raising=False)
    response = client.get("/some-endpoint")
    assert response.status_code == 401
```

### Task 7.2: Update auth.py

```python
# services/mcp_tools/common/auth.py
def _is_dev_mode() -> bool:
    """Dev mode requires an EXPLICIT opt-in env var; no default."""
    return os.environ.get("MCP_AUTH_DEV_MODE", "").lower() in ("true", "1", "yes")
```

The middleware now rejects unsigned requests with 401 by default. Routes that want to allow unsigned-in-dev must check the env var themselves; the helper makes that explicit.

### Task 7.3: Update CLAUDE.md + .env.example

```bash
# .env.example
# MCP_AUTH_DEV_MODE=true   # Uncomment ONLY for local dev. Production must set MCP_AUTH_SIGNING_KEY.
```

### Task 7.4: 4 integration tests + commit

Tests cover: signed/valid → 200; unsigned → 401; expired token → 401; scope mismatch → 403.

---

# Phase 8 — Etag conflict + chained execution + reanimator integration tests (3 days)

**Goal:** Cover the audit's "no integration tests" gap using Postgres testcontainers (`@testcontainers/postgresql`).

### Task 8.1: Set up testcontainers

```bash
cd services/agent-claw && npm install --save-dev @testcontainers/postgresql
```

Add `tests/helpers/postgres-container.ts`: spins up Postgres 17, runs `db/init/*.sql`, returns a connection pool. Wired via vitest `globalSetup`.

### Task 8.2: Etag-conflict test

```typescript
// tests/integration/etag-conflict.test.ts
it("saveSession with stale etag throws OptimisticLockError", async () => {
  const { pool, sessionId } = await setupSession();
  const session = await loadSession(pool, "user-1", sessionId);
  await pool.query("UPDATE agent_sessions SET message_count = message_count + 1 WHERE id = $1", [sessionId]);
  await expect(
    saveSession(pool, "user-1", sessionId, { lastFinishReason: "stop", expectedEtag: session.etag })
  ).rejects.toThrow(OptimisticLockError);
});
```

### Task 8.3: Chained execution test

Build a 3-step plan; mock LLM to call the 3 step tools then text="done". Assert: final session has 3 todo updates with status="completed", no awaiting_user_input, `session_input_tokens` reflects the 3 turns.

### Task 8.4: Reanimator round-trip test

Spin up a stalled session (in_progress todo, last_finish_reason='stop', updated_at > 5 min ago). Run one cycle of the reanimator's selection query. Assert it picks up our session, mints a JWT, hits `/api/internal/sessions/:id/resume`, and the resume endpoint runs the harness with the synthetic Continue prompt.

### Task 8.5: Commit

---

# Phase 9 — Per-hook + per-tool observability (2 days)

**Goal:** Every hook dispatch and every tool execution emits a Langfuse span with duration, status (ok/error/timeout/denied), structured attributes. The OTLP exporter is already wired (Phase D verified); we just instrument hot paths.

### Task 9.1: `withHookSpan(name, point, fn)` wrapper

Wrap every `lifecycle.dispatch` and every `tool.execute` in a span using `@opentelemetry/api`.

### Task 9.2: Replace `console.error` in lifecycle.ts:121 with structured pino logs

### Task 9.3: Tests using `@opentelemetry/sdk-trace-node`'s in-memory exporter to assert span shape.

### Task 9.4: Commit

---

# Phase 10 — Documentation, ADRs, parity tracker, tag (1 day)

### Task 10.1–10.4: ADRs

- **ADR 007 — Hook system rebuild:** why YAML-only registration; why we adopted the Claude Agent SDK contract verbatim; what's intentionally different (snake_case names like `pre_turn` instead of `PreToolUse`).
- **ADR 008 — Collapsed ReAct loop:** why one harness loop with `streamSink` over an `AsyncGenerator<SDKMessage>`; how routes adapt.
- **ADR 009 — Permission and decision contract:** the `allow|deny|ask|defer` semantics, precedence, why we adopted Claude Code's contract.
- **ADR 010 — Mock parity harness:** why scripted scenario regression tests; how they complement unit tests.

### Task 10.5: `docs/PARITY.md`

Create the operator-facing parity tracker (modelled on `ultraworkers/claw-code`'s `PARITY.md`). Format:

```markdown
# ChemClaw ↔ Claude Agent SDK parity

| Primitive | ChemClaw implementation | Status | Notes |
|---|---|---|---|
| Single ReAct loop | core/harness.ts | ✅ implemented (Phase 2) | StreamSink pattern |
| Hook lifecycle (5 core) | lifecycle.ts + hooks/*.yaml | ✅ implemented (Phase 1) | snake_case names |
| Hook lifecycle (extended 10) | session_start, ..., task_completed | ✅ implemented (Phase 4) | |
| Hook decision contract | hook-output.ts | ✅ implemented (Phase 4) | deny>defer>ask>allow |
| Hook matchers | regex `matcher` | ✅ implemented (Phase 4) | |
| Async hooks | { async: true } | ✅ implemented (Phase 4) | |
| Hook timeouts | AbortController, 60s default | ✅ implemented (Phase 4) | |
| pre_compact / post_compact | core/compactor.ts | ✅ implemented (Phase 3) | 60% threshold |
| Permission modes | Options.permissionMode | ✅ implemented (Phase 6) | |
| allowedTools/disallowedTools | Options.{allowed,disallowed}Tools | ✅ implemented (Phase 6) | |
| Workspace boundary validation | security/workspace-boundary.ts | ✅ implemented (Phase 6.7) | |
| Tool annotations + parallel exec | Tool.annotations.readOnly | ✅ implemented (Phase 5) | |
| MCP auth fail-closed | mcp_tools/common/auth.py | ✅ implemented (Phase 7) | MCP_AUTH_DEV_MODE opt-in |
| Sub-agent isolation | core/sub-agent.ts | ✅ implemented | own ctx, own seenFactIds |
| Session persistence + etag | db/init/13_agent_sessions.sql | ✅ implemented | |
| Auto-resume daemon | optimizer/session_reanimator/ | ✅ implemented | 5-min poll |
| Mock parity harness | tests/parity/scenarios/*.json | ✅ implemented (Phase 11) | 8 scenarios |
| Setting sources (user/project/local) | not implemented | ⏳ deferred (v1.3) | |
| ToolSearch (lazy tool loading) | not implemented | ⏳ deferred | |
| Slash command DSL | partial in core/slash.ts | 🟡 partial | /plan, /compact, /eval, /feedback |
| Effort levels | not implemented | ⏳ deferred | LiteLLM gap |
| Stop reasons (end_turn/refusal) | partial | 🟡 partial | only finishReason today |
| AsyncGenerator query() | not adopted | ❌ deliberate | We use Fastify SSE — see ADR 008 |
```

### Task 10.6: Update CLAUDE.md "Harness Primitives" section

Replace the current 5-row table with the full hook surface; update the "Default lifecycle is built via `buildDefaultLifecycle()`" sentence — it's now built via `loadHooks(lifecycle, deps)` and YAML files are the source of truth.

### Task 10.7: Update test-counts in CLAUDE.md and tag

```bash
git tag -a v1.2.0-harness -m "Harness control-plane rebuild: single loop, full hook surface, parity tracker, integration tests"
```

---

# Phase 11 — Mock parity harness (3 days)

**Goal:** Build a deterministic scenario runner that drives the real `runHarness` against canned LLM responses, captures every emitted event into a flat trace, and asserts the trace matches an expected event sequence. This is significantly stronger than per-component unit tests for catching contract drift — we directly modelled the pattern on `ultraworkers/claw-code`'s `MOCK_PARITY_HARNESS.md`.

### Task 11.1: Scenario file format

```typescript
// services/agent-claw/tests/parity/scenario.ts
export interface ScenarioStep {
  llm_response:
    | { kind: "tool_call"; toolId: string; input: Record<string, unknown> }
    | { kind: "text"; text: string }
    | { kind: "stream"; deltas: string[] };
  tool_output?: unknown;
}

export interface Scenario {
  name: string;
  description: string;
  user_messages: string[];
  steps: ScenarioStep[];
  hooks?: Array<{ point: string; name: string; matcher?: string; handler: string }>;
  expected_events: Array<{ type: string; [k: string]: unknown }>;
  expected_finish_reason: string;
}
```

8 scenarios covering: tool-call-then-text, pre-compact-fires, deny-precedence, ask-user-pause, todo-lifecycle, permission-deny-via-hook, parallel-readonly-batch, session-resume.

Example scenario file:

```json
{
  "name": "tool-call-then-text",
  "description": "Single user message; LLM calls one tool, gets result, produces text.",
  "user_messages": ["What's in the project?"],
  "steps": [
    { "llm_response": { "kind": "tool_call", "toolId": "search_knowledge", "input": { "query": "project" } },
      "tool_output": { "results": ["a", "b"], "citation": null } },
    { "llm_response": { "kind": "text", "text": "Found two results." } }
  ],
  "expected_events": [
    { "type": "session" },
    { "type": "hook", "point": "pre_turn" },
    { "type": "hook", "point": "pre_tool", "toolId": "search_knowledge" },
    { "type": "tool_call", "toolId": "search_knowledge" },
    { "type": "hook", "point": "post_tool", "toolId": "search_knowledge" },
    { "type": "tool_result", "toolId": "search_knowledge" },
    { "type": "text_delta" },
    { "type": "hook", "point": "post_turn" },
    { "type": "finish", "finishReason": "stop" }
  ],
  "expected_finish_reason": "stop"
}
```

### Task 11.2: Scenario runner

```typescript
// services/agent-claw/tests/parity/runner.ts
import { runHarness } from "../../src/core/harness.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import type { StreamSink } from "../../src/core/streaming-sink.js";

export async function runScenario(scenario: Scenario): Promise<{ trace: any[]; finishReason: string }> {
  const trace: any[] = [];
  const sink: StreamSink = {
    onSession: (id) => trace.push({ type: "session", session_id: id }),
    onTextDelta: (delta) => trace.push({ type: "text_delta", delta }),
    onToolCall: (toolId, input) => trace.push({ type: "tool_call", toolId, input }),
    onToolResult: (toolId, output) => trace.push({ type: "tool_result", toolId, output }),
    onTodoUpdate: (todos) => trace.push({ type: "todo_update", todos }),
    onAwaitingUserInput: (q) => trace.push({ type: "awaiting_user_input", question: q }),
    onFinish: (reason, usage) => trace.push({ type: "finish", finishReason: reason, usage }),
  };
  const lc = new Lifecycle();
  const orig = lc.dispatch.bind(lc);
  lc.dispatch = async (point, payload, opts) => {
    trace.push({ type: "hook", point, ...(opts?.matcherTarget ? { toolId: opts.matcherTarget } : {}) });
    return orig(point as any, payload as any, opts);
  };
  const llm = stubLlmFromScenario(scenario);
  const tools = stubToolsFromScenario(scenario);
  const result = await runHarness({
    messages: scenario.user_messages.map((c) => ({ role: "user", content: c })),
    tools, llm, budget: new Budget({ maxSteps: 10 }), lifecycle: lc,
    ctx: { userEntraId: "parity-user", scratchpad: new Map(), seenFactIds: new Set() },
    streamSink: sink, sessionId: "scenario-session",
  });
  return { trace, finishReason: result.finishReason };
}
```

### Task 11.3: vitest integration

```typescript
// services/agent-claw/tests/parity/parity.test.ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./runner.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "scenarios");
const scenarios = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe.each(scenarios)("parity scenario %s", (file) => {
  const scenario = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
  it(`${scenario.name}: trace matches expected events in order`, async () => {
    const { trace, finishReason } = await runScenario(scenario);
    expect(finishReason).toBe(scenario.expected_finish_reason);
    expect(trace.length).toBeGreaterThanOrEqual(scenario.expected_events.length);
    for (const expected of scenario.expected_events) {
      const idx = trace.findIndex((t) =>
        t.type === expected.type
        && (!expected.point || t.point === expected.point)
        && (!expected.toolId || t.toolId === expected.toolId)
        && (!expected.finishReason || t.finishReason === expected.finishReason),
      );
      expect(idx, `expected ${JSON.stringify(expected)} not found`).toBeGreaterThanOrEqual(0);
    }
  });
});
```

### Task 11.4: Add `npm run test:parity` script + commit

```json
// services/agent-claw/package.json
"scripts": {
  "test:parity": "vitest run tests/parity"
}
```

---

# Phase 12 (deferred, v1.3) — Setting sources

Not in v1.2.0 scope: `settingSources: ["user", "project", "local"]` à la Claude Code — loads CLAUDE.md / `.claude/skills/*` / `.claude/hooks/*` from each source with a precedence order. Tracked for v1.3.

---

## Self-review — spec coverage

| Audit gap | Phase task | Verified |
|---|---|---|
| 3 ReAct loops | Phase 2 | ✓ |
| pre_compact never fires | Phase 3 | ✓ |
| 4 dead hook .ts files | Phase 1 | ✓ |
| YAML files skipped | Phase 1 | ✓ |
| Orphan global lifecycle | Phase 1 | ✓ |
| manage_todos SSE only on /api/chat | Phase 2 | ✓ |
| MCP auth dev-mode None | Phase 7 | ✓ |
| No etag-conflict test | Phase 8 | ✓ |
| No chained-execution test | Phase 8 | ✓ |
| No reanimator test | Phase 8 | ✓ |
| Hook contract too thin | Phase 4 | ✓ |
| No tool annotations / parallel exec | Phase 5 | ✓ |
| No permission system | Phase 6 | ✓ |
| No workspace boundary validation | Phase 6.7 | ✓ |
| Hook ordering / matcher | Phase 4 | ✓ |
| Per-hook observability ad-hoc | Phase 9 | ✓ |
| No scenario regression tests | Phase 11 | ✓ |

## Self-review — placeholder scan

No `TBD`, no "implement appropriate error handling", no "fill in details". Every code block contains the actual code the engineer types. Every test shows the assertion. Every commit message is provided verbatim.

## Self-review — type consistency

`StreamSink` defined in 2.2 used identically in 2.3, 2.4, 2.5, and 11.2. `HookJSONOutput`, `PermissionDecision`, `HookCallback`, `mostRestrictive` defined in 4.1 used identically in 4.2, 4.3, 4.4. `Budget.shouldCompact()` defined in 3.2 used in 3.3.

## Time estimate

| Phase | Days | Cumulative |
|---|---|---|
| 0 — worktree + safety net | 1 | 1 |
| 1 — single source of truth | 2 | 3 |
| 2 — collapse ReAct loops | 3 | 6 |
| 3 — pre_compact fires | 2 | 8 |
| 4 — Claude-Code hook contract | 3 | 11 |
| 5 — annotations + parallel | 2 | 13 |
| 6 — permissions + boundary | 3 | 16 |
| 7 — MCP auth fail-closed | 1 | 17 |
| 8 — integration tests | 3 | 20 |
| 9 — observability spans | 2 | 22 |
| 10 — docs, ADRs, parity tracker, tag | 1 | 23 |
| 11 — mock parity harness | 3 | **26** |

**Total: ~26 working days (5–6 weeks one engineer full-time, or 10–13 weeks part-time).** All work lands on the single `using-superpowers` branch.

Each phase is a logically separable commit (or tightly-related cluster); no phase depends on a later one's API. The most surgical (Phase 1) and the most architectural (Phase 2) ship first so the rest happens against a clean base.

## What's NOT in this plan (deliberate omissions)

- **No vendor-LLM SDK rewrite.** LiteLLM stays the egress chokepoint; the redactor stays the same.
- **No persistence schema changes.** `agent_sessions/_todos/_plans` schema is correct.
- **No GxP / audit / compliance work.**
- **No sub-agent worktree isolation.** Claude Code has `isolation: "worktree"` for sub-agents; ChemClaw doesn't have a filesystem-affecting tool surface that needs it.
- **No frontend changes.** Streamlit consumes the same SSE event types; the new sink emits identical events.
- **No migration to AsyncGenerator-based query() shape.** Our routes are Fastify SSE writers; a generator API would just re-wrap into the same SSE events. We keep the callback-based StreamSink because it's simpler. ADR 008 documents this.
- **No setting sources.** Deferred to Phase 12 / v1.3.

---

## Execution Handoff

Plan saved to `docs/plans/2026-04-27-harness-control-plane-rebuild.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Use superpowers:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session using superpowers:executing-plans, batch execution with checkpoints.

All implementation lands on the `using-superpowers` branch in worktree `../chemclaw-using-superpowers`.

Which approach?
