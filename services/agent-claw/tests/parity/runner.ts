// Phase 11: Mock parity harness runner.
//
// Drives the real runHarness against canned LLM responses (StubLlmProvider)
// and captures every Lifecycle dispatch into a flat trace.
// assertEventsMatch then checks that every expected event appears in order —
// extra events are allowed so adding new hooks doesn't churn every scenario.
//
// See scenario.ts for the rationale on why this port is lifecycle-only
// (no StreamSink — main has none).

import { z } from "zod";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { runHarness } from "../../src/core/harness.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool, type Tool } from "../../src/tools/tool.js";
import { AwaitingUserInputError } from "../../src/tools/builtins/ask_user.js";
import type {
  HookPoint,
  PermissionOptions,
  ToolContext,
} from "../../src/core/types.js";
import type {
  ExpectedEvent,
  Scenario,
  TraceEvent,
} from "./scenario.js";

/**
 * Run a scenario end-to-end and return the captured event trace plus the
 * final finishReason. The runner:
 *
 *   1. Builds a Lifecycle and registers any scenario.hooks.
 *   2. Wraps lifecycle.dispatch + lifecycle.dispatchPermissionRequest so
 *      every dispatch appends a "hook" event to the trace BEFORE invoking
 *      the real dispatcher.
 *   3. Builds a StubLlmProvider seeded from scenario.steps.
 *   4. Builds one stub Tool per unique toolId referenced in the steps; each
 *      stub returns its scenario-defined tool_output (or {ok:true}). The
 *      special toolId "ask_user" throws AwaitingUserInputError to exercise
 *      the pause-the-loop control-flow path.
 *   5. Calls runHarness with the assembled inputs and returns the trace.
 */
export async function runScenario(
  scenario: Scenario,
): Promise<{ trace: TraceEvent[]; finishReason: string }> {
  const trace: TraceEvent[] = [];

  const lc = new Lifecycle();

  // Register any scenario-defined hooks BEFORE wrapping dispatch so the
  // wrapped dispatch sees them in flight too.
  if (scenario.hooks) {
    for (const h of scenario.hooks) {
      if (h.behavior === "deny" && h.point !== "permission_request") {
        throw new Error(
          `parity runner: behavior="deny" is only supported at permission_request on this main; ` +
            `scenario "${scenario.name}" requested it at "${h.point}".`,
        );
      }
      lc.on(h.point as HookPoint, h.name, async () => {
        if (h.behavior === "deny") {
          // Use the SDK-shape return that lifecycle.dispatchPermissionRequest
          // recognises (PermissionHookSdkShape).
          return {
            hookSpecificOutput: {
              hookEventName: "permission_request" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: `scenario hook ${h.name}`,
            },
          };
        }
        return undefined;
      });
    }
  }

  // Wrap dispatch so every lifecycle dispatch appends a "hook" event to the
  // trace. We capture the call shape (point + matcherTarget) BEFORE invoking
  // the real dispatcher so the trace mirrors when the harness asked for the
  // dispatch, not when it returned.
  const origDispatch = lc.dispatch.bind(lc);
  lc.dispatch = async (point, payload, opts) => {
    const entry: TraceEvent = { type: "hook", point };
    if (opts?.matcherTarget) entry.toolId = opts.matcherTarget;
    trace.push(entry);
    return origDispatch(point, payload, opts);
  };

  const origPerm = lc.dispatchPermissionRequest.bind(lc);
  lc.dispatchPermissionRequest = async (payload, opts) => {
    trace.push({
      type: "hook",
      point: "permission_request",
      toolId: opts?.matcherTarget ?? payload.toolId,
    });
    return origPerm(payload, opts);
  };

  // Build the stubbed LLM with the scenario's responses.
  const llm = new StubLlmProvider();
  for (const step of scenario.steps) {
    if (step.llm_response.kind === "tool_call") {
      llm.enqueueToolCall(step.llm_response.toolId, step.llm_response.input);
    } else {
      llm.enqueueText(step.llm_response.text);
    }
  }

  // Build a stub Tool per unique tool id referenced in the scenario. Each
  // stub returns the per-step tool_output the scenario declared (indexed by
  // call number so a tool invoked twice with different outputs still works).
  interface FlatToolStep {
    toolId: string;
    output?: unknown;
  }
  const toolCallSteps: FlatToolStep[] = scenario.steps
    .filter((s): s is ScenarioToolCallStep => s.llm_response.kind === "tool_call")
    .map((s) => ({
      toolId: s.llm_response.toolId,
      output: s.tool_output,
    }));
  const toolIds = [...new Set(toolCallSteps.map((s) => s.toolId))];
  const callCounts: Record<string, number> = {};
  for (const id of toolIds) callCounts[id] = 0;
  const tools: Tool[] = toolIds.map((id) =>
    defineTool({
      id,
      description: `parity scenario stub tool ${id}`,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async (_ctx, input) => {
        // ask_user is special-cased: throw the harness's pause-the-loop
        // control-flow exception so a scenario can verify the pause path
        // without wiring the real DB-backed builtin.
        if (id === "ask_user") {
          const q =
            input && typeof input === "object" && "question" in input
              ? String((input as { question: unknown }).question)
              : "(scenario ask_user)";
          throw new AwaitingUserInputError(q);
        }
        const matches = toolCallSteps.filter((s) => s.toolId === id);
        const idx = callCounts[id]!++;
        return matches[idx]?.output ?? { ok: true };
      },
      annotations: { readOnly: true },
    }),
  );

  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  const ctx: ToolContext = {
    userEntraId: "parity-user",
    scratchpad,
    seenFactIds,
  };

  // ask_user's AwaitingUserInputError is control-flow, not failure: catch it
  // here so a scenario that exercises the pause path can still assert on the
  // captured trace. The harness's finally block runs post_turn before the
  // throw bubbles up, so the trace is complete.
  let finishReason: string;
  try {
    const result = await runHarness({
      messages: scenario.user_messages.map((c) => ({
        role: "user" as const,
        content: c,
      })),
      tools,
      llm,
      budget: new Budget({
        maxSteps: scenario.budget?.maxSteps ?? 10,
        maxPromptTokens: scenario.budget?.maxPromptTokens ?? 100_000,
      }),
      lifecycle: lc,
      ctx,
      permissions: scenario.permissions as PermissionOptions | undefined,
    });
    finishReason = result.finishReason;
  } catch (err) {
    if (err instanceof AwaitingUserInputError) {
      finishReason = "awaiting_user_input";
    } else {
      throw err;
    }
  }

  return { trace, finishReason };
}

// Narrow type used inside runScenario only.
interface ScenarioToolCallStep {
  llm_response: { kind: "tool_call"; toolId: string; input: Record<string, unknown> };
  tool_output?: unknown;
}

/**
 * Verify that every expected event appears in order in the trace. Allows
 * arbitrary additional events between matches — the assertion is "expected
 * is a subsequence of trace", not "expected equals trace exactly". Throws
 * with a diagnostic message that includes the trace types in order so a
 * mismatch is debuggable from the failure log alone.
 */
export function assertEventsMatch(
  trace: TraceEvent[],
  expected: ExpectedEvent[],
): void {
  let cursor = 0;
  for (const exp of expected) {
    let idx = -1;
    for (let i = cursor; i < trace.length; i++) {
      const t = trace[i]!;
      if (t.type !== exp.type) continue;
      if (exp.point && t.point !== exp.point) continue;
      if (exp.toolId && t.toolId !== exp.toolId) continue;
      idx = i;
      break;
    }
    if (idx < 0) {
      const traceStr = trace
        .map((t) => {
          const extras: string[] = [`point=${t.point}`];
          if (t.toolId) extras.push(`toolId=${t.toolId}`);
          return `${t.type}{${extras.join(",")}}`;
        })
        .join(" -> ");
      throw new Error(
        `expected event ${JSON.stringify(exp)} not found in trace after position ${cursor}.\n` +
          `Trace: ${traceStr}`,
      );
    }
    cursor = idx + 1;
  }
}
