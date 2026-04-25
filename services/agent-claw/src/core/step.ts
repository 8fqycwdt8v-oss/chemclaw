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

export interface StepOnceOptions {
  llm: LlmProvider;
  tools: Tool[];
  messages: Message[];
  lifecycle: Lifecycle;
  ctx: ToolContext;
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
  const { llm, tools, messages, lifecycle, ctx } = opts;

  // 1. LLM call.
  const { result, usage } = await llm.call(messages, tools);

  if (result.kind === "text") {
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

  // 3a. pre_tool — hooks may throw to abort, may mutate input.
  const prePayload = { ctx, toolId, input };
  await lifecycle.dispatch("pre_tool", prePayload);
  // Input may have been mutated by a hook.
  const effectiveInput = prePayload.input;

  // 3b. Validate input.
  const parsedInput = tool.inputSchema.parse(effectiveInput);

  // 3c. Execute.
  const rawOutput = await tool.execute(ctx, parsedInput);

  // 3d. Validate output.
  const parsedOutput = tool.outputSchema.parse(rawOutput);

  // 3e. post_tool.
  const postPayload = { ctx, toolId, input: effectiveInput, output: parsedOutput };
  await lifecycle.dispatch("post_tool", postPayload);
  // Output may have been mutated by a hook.
  const effectiveOutput = postPayload.output;

  return {
    step: result,
    toolOutput: effectiveOutput,
    usage,
  };
}
