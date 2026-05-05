// stepOnce — one LLM call → parse result → execute tool(s) (if tool_call(s)).
// The harness while-loop calls this repeatedly until "text" or budget hits.
//
// Phase A.1: tool input validation via Zod is performed here; output
// validation is also performed here. Both throw on failure, which the
// harness surfaces as an error (no silent failure).
//
// Phase 5: when the LLM emits multiple tool calls in one assistant message
// (StepResult kind === "tool_calls"), stepOnce groups consecutive read-only
// tools into a batch and runs them via Promise.all. Any state-mutating tool
// in the batch causes the entire batch to fall back to sequential execution
// (defensive — parallel + state-mutating is footgun territory). The return
// shape is always a `toolOutputs` array so the harness can push one tool
// message per call into history; single-call turns return a 1-element array
// (wire-compatible with the prior single-tool shape).

import type { LlmProvider } from "../llm/provider.js";
import type { Lifecycle } from "./lifecycle.js";
import type {
  Message,
  PermissionOptions,
  StepResult,
  ToolContext,
} from "./types.js";
import type { Tool } from "../tools/tool.js";
import type { StreamSink } from "./streaming-sink.js";
import { runOneTool, type StepToolOutput } from "./run-one-tool.js";

export type { StepToolOutput } from "./run-one-tool.js";

export interface StepOnceOptions {
  llm: LlmProvider;
  tools: Tool[];
  messages: Message[];
  lifecycle: Lifecycle;
  ctx: ToolContext;
  /**
   * Optional streaming sink. When set, text steps are driven via
   * llm.streamCompletion (call-then-stream pattern: call() detects
   * text-vs-tool-call, streamCompletion() drives token-by-token output)
   * and tool brackets fire onToolCall / onToolResult.
   */
  streamSink?: StreamSink;
  /**
   * Phase 6: optional permission policy. When set, the resolver runs
   * before pre_tool dispatch and can short-circuit a tool call with
   * deny / defer.
   */
  permissions?: PermissionOptions;
}

export interface StepOnceResult {
  step: StepResult;
  /**
   * Per-tool outputs in batch order. Empty for `kind === "text"` steps.
   * For single-tool turns this is a 1-element array; for multi-tool turns
   * it contains one entry per executed tool.
   */
  toolOutputs: StepToolOutput[];
  usage: { promptTokens: number; completionTokens: number };
}

/**
 * Execute one step of the ReAct loop:
 * 1. Call the LLM with the current message history + tool schemas.
 * 2. If the model returns a text completion, return it immediately.
 * 3. If the model returns one or more tool_calls:
 *    a. Group consecutive read-only tools into a batch (Phase 5).
 *    b. For a read-only batch: run each tool via Promise.all.
 *    c. For a single tool or any batch containing a state-mutating tool:
 *       run sequentially (defensive).
 *    d. After execution, dispatch post_tool_batch ONCE with the batch array.
 *    e. Return the step + outputs.
 *
 * Does NOT push anything to `messages` — the harness does that so it owns
 * the message history.
 */
export async function stepOnce(opts: StepOnceOptions): Promise<StepOnceResult> {
  const { llm, tools, messages, lifecycle, ctx, streamSink, permissions } = opts;
  // Propagate the upstream AbortSignal (set by runHarness from
  // HarnessOptions.signal) into every LLM call so a client disconnect
  // cancels the underlying fetch instead of running the model to
  // completion. Tool dispatch reads the same signal off ctx.
  const signal = ctx.signal;

  // 1. LLM call.
  const { result, usage } = await llm.call(messages, tools, { signal });

  if (result.kind === "text") {
    // Text path with streaming sink — re-run the call as a stream so tokens
    // flow to the sink as they arrive. Call-then-stream pattern: call()
    // already established this is a text step; streamCompletion() drives
    // output deltas. 2x round-trip on text turns is a known tradeoff vs.
    // the more complex stream-first approach.
    if (streamSink) {
      let streamed = "";
      for await (const chunk of llm.streamCompletion(messages, tools, { signal })) {
        if (chunk.type === "text_delta") {
          streamSink.onTextDelta?.(chunk.delta);
          streamed += chunk.delta;
        }
        // Other chunk types (tool_call, finish) are ignored — call() already
        // told us this is a text step; the harness emits its own finish event.
      }
      const streamedStep: StepResult = { kind: "text", text: streamed };
      return { step: streamedStep, toolOutputs: [], usage };
    }
    return { step: result, toolOutputs: [], usage };
  }

  // 2. Normalise tool_call (singular) and tool_calls (plural) to one batch.
  const calls: Array<{ toolId: string; input: unknown }> =
    result.kind === "tool_call"
      ? [{ toolId: result.toolId, input: result.input }]
      : result.calls;

  // Defensive: an empty batch shouldn't reach here, but if it does, surface
  // it as if the LLM had returned text so the loop terminates cleanly.
  if (calls.length === 0) {
    return {
      step: { kind: "text", text: "" },
      toolOutputs: [],
      usage,
    };
  }

  // 3. Decide: parallel-eligible (all read-only) or sequential?
  // Look up each tool's annotation on the registry. Unknown / unannotated
  // tools default to NOT read-only (conservative). A single-element batch
  // always runs through the same code path; whether we use Promise.all or
  // a serial loop is moot for length === 1 but we still flow through the
  // sequential path for consistency.
  const allReadOnly =
    calls.length > 1 &&
    calls.every((c) => {
      const t = tools.find((tool) => tool.id === c.toolId);
      return t?.annotations?.readOnly === true;
    });

  const toolOutputs: StepToolOutput[] = [];

  if (allReadOnly) {
    // 3a. Parallel batch: dispatch pre_tool / execute / post_tool for each
    // tool. runOneTool encapsulates the pre/exec/post sequence; we wrap
    // them all in Promise.all so the wall-clock time is max(durations)
    // rather than sum(durations). Errors propagate via Promise.all's
    // fast-fail behaviour: the first rejection rejects the aggregate. Any
    // sibling tools that already completed have their results captured by
    // runOneTool's resolved promises but are then lost when we re-throw —
    // acceptable per spec (the failure is the visible event).
    const settled = await Promise.all(
      calls.map((c) =>
        runOneTool({
          tools,
          toolId: c.toolId,
          input: c.input,
          lifecycle,
          ctx,
          streamSink,
          permissions,
          inBatch: true,
        }),
      ),
    );
    toolOutputs.push(...settled);
  } else {
    // 3b. Sequential fallback: any state-mutating tool in the batch (or a
    // single-tool turn) runs serially. Tools see each other's side effects
    // in declared order, matching the pre-Phase-5 behaviour.
    for (const c of calls) {
      const out = await runOneTool({
        tools,
        toolId: c.toolId,
        input: c.input,
        lifecycle,
        ctx,
        streamSink,
        permissions,
      });
      toolOutputs.push(out);
    }
  }

  // 4. post_tool_batch fires ONCE per batch with the multi-entry array.
  // Phase 4B preserved a single-entry shape so hook authors could register
  // before Phase 5 landed; today the entry count matches the actual batch
  // size (1 for single-tool turns, N for multi-tool turns).
  await lifecycle.dispatch("post_tool_batch", {
    ctx,
    batch: toolOutputs.map((o, i) => {
      const call = calls[i];
      // Invariant: toolOutputs comes from the same calls[] indexing path,
      // so calls[i] is always present here.
      if (!call) {
        throw new Error(`step: calls[${i}] missing for toolOutput ${o.toolId}`);
      }
      return {
        toolId: o.toolId,
        input: call.input,
        output: o.output,
      };
    }),
  });

  return {
    step: result,
    toolOutputs,
    usage,
  };
}
