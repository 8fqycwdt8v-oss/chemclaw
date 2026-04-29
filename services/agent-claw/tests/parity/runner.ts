// Phase 11: Mock parity harness runner.
//
// Drives the real runHarness against canned LLM responses (StubLlmProvider)
// and captures every event emitted via StreamSink callbacks + every
// Lifecycle.dispatch into a flat trace. assertEventsMatch then checks that
// every expected event appears in order — extra events are allowed so
// adding new hooks / events doesn't churn every scenario.

import { z } from "zod";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { runHarness } from "../../src/core/harness.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import type { StreamSink } from "../../src/core/streaming-sink.js";
import type { Tool } from "../../src/tools/tool.js";
import type {
  HookPayloadMap,
  HookPoint,
  PermissionOptions,
  ToolContext,
} from "../../src/core/types.js";
import { AwaitingUserInputError } from "../../src/tools/builtins/ask_user.js";
import type { Scenario, ExpectedEvent } from "./scenario.js";

export interface TraceEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Run a scenario end-to-end and return the captured event trace plus the
 * final finishReason. The runner:
 *
 *   1. Builds a Lifecycle, optionally registers scenario.hooks.
 *   2. Wraps lifecycle.dispatch so every dispatch appends a "hook" event to
 *      the trace BEFORE invoking the real dispatcher.
 *   3. Builds a StubLlmProvider seeded from scenario.steps.
 *   4. Builds one stub Tool per unique toolId referenced in the steps; each
 *      stub returns its scenario-defined tool_output (or {ok:true}).
 *   5. Wires a StreamSink whose every callback appends to the trace.
 *   6. Calls runHarness with the assembled inputs and returns the trace.
 *
 * Designed to be small (~80 LOC of meat) — the goal is "JSON in, trace out"
 * with no scenario-specific Python in this file.
 */
export async function runScenario(
  scenario: Scenario,
): Promise<{ trace: TraceEvent[]; finishReason: string }> {
  const trace: TraceEvent[] = [];

  const sink: StreamSink = {
    onSession: (id) => trace.push({ type: "session", session_id: id }),
    onTextDelta: (delta) => trace.push({ type: "text_delta", delta }),
    onToolCall: (toolId, input) =>
      trace.push({ type: "tool_call", toolId, input }),
    onToolResult: (toolId, output) =>
      trace.push({ type: "tool_result", toolId, output }),
    onTodoUpdate: (todos) => trace.push({ type: "todo_update", todos }),
    onAwaitingUserInput: (q) =>
      trace.push({ type: "awaiting_user_input", question: q }),
    onFinish: (reason, usage) =>
      trace.push({ type: "finish", finishReason: reason, usage }),
  };

  const lc = new Lifecycle();

  // Register any scenario-defined hooks BEFORE wrapping dispatch so the
  // wrapped dispatch sees them in flight too.
  if (scenario.hooks) {
    for (const h of scenario.hooks) {
      lc.on(
        h.point as HookPoint,
        h.name,
        async () => {
          if (h.behavior === "deny") {
            return {
              hookSpecificOutput: {
                hookEventName: h.point,
                permissionDecision: "deny" as const,
                permissionDecisionReason: `scenario hook ${h.name}`,
              },
            };
          }
          return {};
        },
        { matcher: h.matcher },
      );
    }
  }

  // Wrap dispatch so every lifecycle dispatch appends a "hook" event to the
  // trace. We capture the call shape (point + matcherTarget) BEFORE invoking
  // the real dispatcher so the trace mirrors when the harness asked for the
  // dispatch, not when it returned.
  const origDispatch = lc.dispatch.bind(lc);
  lc.dispatch = async <P extends HookPoint>(
    point: P,
    payload: HookPayloadMap[P],
    opts?: { toolUseID?: string; matcherTarget?: string },
  ) => {
    const entry: TraceEvent = { type: "hook", point };
    if (opts?.matcherTarget) entry.toolId = opts.matcherTarget;
    trace.push(entry);
    return origDispatch(point, payload, opts);
  };

  // Build the stubbed LLM with the scenario's responses. Per-step usage
  // overrides (used to trip pre_compact deterministically) flow through
  // enqueue() / enqueueToolCall() / enqueueToolCalls() — enqueueStream
  // doesn't accept usage but emits a finish chunk with default usage which
  // is fine for streaming-only paths.
  const llm = new StubLlmProvider();
  scenario.steps.forEach((step, i) => {
    const usage = scenario.step_usage_overrides?.[String(i)];
    if (step.llm_response.kind === "tool_call") {
      if (usage) {
        llm.enqueueToolCall(step.llm_response.toolId, step.llm_response.input, usage);
      } else {
        llm.enqueueToolCall(step.llm_response.toolId, step.llm_response.input);
      }
    } else if (step.llm_response.kind === "tool_calls") {
      const calls = step.llm_response.calls.map((c) => ({
        toolId: c.toolId,
        input: c.input,
      }));
      if (usage) {
        llm.enqueueToolCalls(calls, usage);
      } else {
        llm.enqueueToolCalls(calls);
      }
    } else if (step.llm_response.kind === "text") {
      if (usage) {
        llm.enqueueText(step.llm_response.text, usage);
      } else {
        llm.enqueueText(step.llm_response.text);
      }
    } else {
      llm.enqueueStream(
        step.llm_response.deltas.map((d) => ({
          type: "text_delta" as const,
          delta: d,
        })),
      );
    }
  });

  // Build a stub Tool per unique tool id referenced in the scenario. Each
  // stub returns the per-step tool_output the scenario declared (last call
  // wins if the same tool is invoked twice with different outputs — instead
  // the runner indexes by call number to keep a 1:1 mapping with steps).
  // Flatten tool_call + tool_calls steps into a single list so the call-counter
  // logic below works uniformly across both shapes.
  interface FlatToolStep {
    toolId: string;
    output?: unknown;
  }
  const toolCallSteps: FlatToolStep[] = [];
  for (const s of scenario.steps) {
    if (s.llm_response.kind === "tool_call") {
      toolCallSteps.push({
        toolId: s.llm_response.toolId,
        output: s.tool_output,
      });
    } else if (s.llm_response.kind === "tool_calls") {
      for (const c of s.llm_response.calls) {
        toolCallSteps.push({ toolId: c.toolId, output: c.output });
      }
    }
  }
  const toolIds = [...new Set(toolCallSteps.map((s) => s.toolId))];
  const callCounts: Record<string, number> = {};
  for (const id of toolIds) callCounts[id] = 0;
  const tools: Tool[] = toolIds.map((id) => {
    // Define each stub tool with an `unknown` input schema so the resulting
    // Tool<unknown, unknown> is assignable into the harness's Tool[] without
    // a wider variance cast. The scenario JSON dictates the input shape; the
    // tool body never inspects it.
    const stub: Tool = {
      id,
      description: `parity scenario stub tool ${id}`,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async (_ctx, input) => {
        // Find the Nth tool_output for this tool id (where N is the
        // call-count for this id so far). Falls back to {ok:true} if the
        // scenario did not supply an output.
        const matches = toolCallSteps.filter((s) => s.toolId === id);
        const idx = callCounts[id]!++;
        // Special-case: a scenario can simulate ask_user's pause-the-loop
        // semantics by referencing the literal tool id "ask_user". The
        // stub throws AwaitingUserInputError so the harness exits via the
        // same control-flow path as the real builtin.
        if (id === "ask_user") {
          const q =
            input && typeof input === "object" && "question" in input
              ? String((input as { question: unknown }).question)
              : "(scenario ask_user)";
          throw new AwaitingUserInputError(q);
        }
        return matches[idx]?.output ?? { ok: true };
      },
      annotations: { readOnly: true },
    };
    return stub;
  });

  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  const ctx: ToolContext = {
    userEntraId: "parity-user",
    scratchpad,
    seenFactIds,
    lifecycle: lc,
  };

  // ask_user's AwaitingUserInputError is control-flow, not failure: catch it
  // here so a scenario that exercises the pause path can still assert on the
  // captured trace. The harness's finally block runs post_turn + onFinish
  // before the throw bubbles up, so the trace is complete.
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
      streamSink: sink,
      sessionId: "scenario-session",
      permissions: scenario.permissions as PermissionOptions | undefined,
    });
    finishReason = result.finishReason;
  } catch (err) {
    if (err instanceof AwaitingUserInputError) {
      // The harness sets finishReason = "awaiting_user_input" before
      // re-throwing; mirror that here so the scenario's
      // expected_finish_reason can match.
      finishReason = "awaiting_user_input";
    } else {
      throw err;
    }
  }

  return { trace, finishReason };
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
    const idx = trace.findIndex(
      (t, i) =>
        i >= cursor &&
        t.type === exp.type &&
        (!exp.point || t.point === exp.point) &&
        (!exp.toolId || t.toolId === exp.toolId) &&
        (!exp.finishReason || t.finishReason === exp.finishReason),
    );
    if (idx < 0) {
      const traceTypes = trace
        .map((t) => {
          const extras: string[] = [];
          if (t.point) extras.push(`point=${String(t.point)}`);
          if (t.toolId) extras.push(`toolId=${String(t.toolId)}`);
          if (t.finishReason) extras.push(`finishReason=${String(t.finishReason)}`);
          return extras.length ? `${t.type}{${extras.join(",")}}` : t.type;
        })
        .join(" -> ");
      throw new Error(
        `expected event ${JSON.stringify(exp)} not found in trace after position ${cursor}.\n` +
          `Trace: ${traceTypes}`,
      );
    }
    cursor = idx + 1;
  }
}
