// LlmProvider interface + StubLlmProvider for deterministic tests.
// Real LiteLLM wiring lands in Phase A.2.

import type { Message, StepResult } from "../core/types.js";
import type { Tool } from "../tools/tool.js";

// ---------------------------------------------------------------------------
// Response returned by one LLM call.
// ---------------------------------------------------------------------------
export interface LlmResponse {
  /** The step result — either a text completion or a tool call. */
  result: StepResult;
  /** Token usage reported by the provider. */
  usage: { promptTokens: number; completionTokens: number };
}

// ---------------------------------------------------------------------------
// The interface every provider must implement.
// Phase A.2 will add LiteLLMProvider that calls the gateway at the configured
// baseURL with the model role (planner / executor / compactor).
// ---------------------------------------------------------------------------
export interface LlmProvider {
  /**
   * Execute one step: send messages + tool schemas to the model and return
   * a parsed result (text or tool_call) plus token usage.
   */
  call(messages: Message[], tools: Tool[]): Promise<LlmResponse>;
}

// ---------------------------------------------------------------------------
// StubLlmProvider — fully deterministic, zero network calls.
// Enqueue responses before a test; each call() dequeues the next one.
// If the queue is empty, throws so tests catch accidental extra calls.
// ---------------------------------------------------------------------------
export class StubLlmProvider implements LlmProvider {
  private readonly _queue: LlmResponse[] = [];

  /** Push a response that will be returned on the next call(). */
  enqueue(response: LlmResponse): this {
    this._queue.push(response);
    return this;
  }

  /** Convenience: enqueue a text completion. */
  enqueueText(
    text: string,
    usage: { promptTokens: number; completionTokens: number } = {
      promptTokens: 10,
      completionTokens: 10,
    },
  ): this {
    return this.enqueue({ result: { kind: "text", text }, usage });
  }

  /** Convenience: enqueue a tool_call step. */
  enqueueToolCall(
    toolId: string,
    input: unknown,
    usage: { promptTokens: number; completionTokens: number } = {
      promptTokens: 10,
      completionTokens: 5,
    },
  ): this {
    return this.enqueue({ result: { kind: "tool_call", toolId, input }, usage });
  }

  /** Number of unconsumed responses remaining. */
  get pending(): number {
    return this._queue.length;
  }

  async call(_messages: Message[], _tools: Tool[]): Promise<LlmResponse> {
    const next = this._queue.shift();
    if (!next) {
      throw new Error(
        "StubLlmProvider: call() invoked but the response queue is empty. " +
          "Did you forget to enqueue a response for this step?",
      );
    }
    return next;
  }
}
