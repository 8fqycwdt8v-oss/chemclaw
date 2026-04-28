// stepOnce — one LLM call → parse result → execute tool (if tool_call).
// The harness while-loop calls this repeatedly until "text" or budget hits.
//
// Phase A.1: tool input validation via Zod is performed here; output
// validation is also performed here. Both throw on failure, which the
// harness surfaces as an error (no silent failure).

import type { LlmProvider } from "../llm/provider.js";
import type { Lifecycle } from "./lifecycle.js";
import type { Message, StepResult, ToolContext } from "./types.js";
import type { Tool } from "../tools/tool.js";
import type { StreamSink, TodoSnapshot } from "./streaming-sink.js";

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
}

export interface StepOnceResult {
  step: StepResult;
  /** Tool output (only present when step.kind === "tool_call"). */
  toolOutput?: unknown;
  usage: { promptTokens: number; completionTokens: number };
}

/**
 * Execute one step of the ReAct loop:
 * 1. Call the LLM with the current message history + tool schemas.
 * 2. If the model returns a text completion, return it immediately.
 * 3. If the model returns a tool_call:
 *    a. Fire pre_tool (may throw — propagates to caller).
 *    b. Validate input against the tool's inputSchema.
 *    c. Execute the tool.
 *    d. Validate output against the tool's outputSchema.
 *    e. Fire post_tool.
 *    f. Return the step + output.
 *
 * Does NOT push anything to `messages` — the harness does that so it owns
 * the message history.
 */
export async function stepOnce(opts: StepOnceOptions): Promise<StepOnceResult> {
  const { llm, tools, messages, lifecycle, ctx, streamSink } = opts;

  // 1. LLM call.
  const { result, usage } = await llm.call(messages, tools);

  if (result.kind === "text") {
    // 1b. Text path with streaming sink — re-run the call as a stream so
    //     tokens flow to the sink as they arrive. Call-then-stream pattern
    //     (matches chat.ts:657 today): call() above already established
    //     this is a text step; streamCompletion() drives output deltas.
    //     2x round-trip on text turns is a known tradeoff vs. the more
    //     complex stream-first approach.
    if (streamSink) {
      let streamed = "";
      for await (const chunk of llm.streamCompletion(messages, tools)) {
        if (chunk.type === "text_delta") {
          streamSink.onTextDelta?.(chunk.delta);
          streamed += chunk.delta;
        }
        // Other chunk types (tool_call, finish) are ignored — call() already
        // told us this is a text step; the harness emits its own finish event.
      }
      // The streamed text is the canonical assistant response (matches
      // chat.ts behaviour: streamed wins over the call() text when present).
      const streamedStep: StepResult = { kind: "text", text: streamed };
      return { step: streamedStep, usage };
    }
    return { step: result, usage };
  }

  // 2. Tool_call path.
  const { toolId, input } = result;

  // Find the tool — missing tool is a logic error (registry should have it).
  const tool = tools.find((t) => t.id === toolId);
  if (!tool) {
    throw new Error(
      `stepOnce: model requested unknown tool "${toolId}". ` +
        `Available: [${tools.map((t) => t.id).join(", ")}]`,
    );
  }

  // 3a. pre_tool — hooks may throw to abort (legacy budget-guard path), may
  // mutate input via in-place writes, may return a permissionDecision, or
  // may return updatedInput to rewrite the call.
  const prePayload = { ctx, toolId, input };
  const preResult = await lifecycle.dispatch("pre_tool", prePayload, {
    toolUseID: toolId,
    matcherTarget: toolId,
  });

  // 3a-deny. A pre_tool hook returned permissionDecision: "deny". Skip
  // tool.execute and surface a synthetic rejection so the model sees the
  // refusal and can adjust on the next step.
  if (preResult.decision === "deny") {
    const denyOutput = {
      error: "denied_by_hook",
      reason: preResult.reason ?? "denied without reason",
    };
    // Notify the sink so the UI shows the call was attempted but denied.
    streamSink?.onToolCall?.(toolId, prePayload.input);
    streamSink?.onToolResult?.(toolId, denyOutput);
    return {
      step: result,
      toolOutput: denyOutput,
      usage,
    };
  }
  // "ask" / "defer" require route-level handling (interactive permission
  // prompt) that's out of scope for Phase 4A. For now, treat them as allow.
  // TODO(phase-6-permissions): wire ask/defer to a route-level prompt.

  // updatedInput from a hook supersedes any in-place mutation.
  const effectiveInput =
    preResult.updatedInput !== undefined ? preResult.updatedInput : prePayload.input;

  // 3b. Validate input.
  const parsedInput = tool.inputSchema.parse(effectiveInput);

  // 3b-sink. Notify the sink that a tool call is about to execute. Fires
  // AFTER pre_tool so any input mutation by hooks is visible to the sink.
  streamSink?.onToolCall?.(toolId, parsedInput);

  // 3c. Execute.
  const rawOutput = await tool.execute(ctx, parsedInput);

  // 3d. Validate output.
  const parsedOutput = tool.outputSchema.parse(rawOutput);

  // 3e. post_tool.
  const postPayload = { ctx, toolId, input: effectiveInput, output: parsedOutput };
  await lifecycle.dispatch("post_tool", postPayload, {
    toolUseID: toolId,
    matcherTarget: toolId,
  });
  // Output may have been mutated by a hook.
  const effectiveOutput = postPayload.output;

  // 3e-sink. Notify the sink with the (post-hook) output.
  streamSink?.onToolResult?.(toolId, effectiveOutput);

  // 3f-sink. manage_todos special-case: surface the latest checklist via
  //          onTodoUpdate so the route can emit a `todo_update` SSE event.
  //          The tool's output schema guarantees a `todos` array; we still
  //          type-narrow defensively in case a hook mutates the output.
  if (
    streamSink?.onTodoUpdate &&
    toolId === "manage_todos" &&
    effectiveOutput &&
    typeof effectiveOutput === "object" &&
    "todos" in effectiveOutput &&
    Array.isArray((effectiveOutput as { todos: unknown }).todos)
  ) {
    streamSink.onTodoUpdate(
      (effectiveOutput as { todos: TodoSnapshot[] }).todos,
    );
  }

  return {
    step: result,
    toolOutput: effectiveOutput,
    usage,
  };
}
