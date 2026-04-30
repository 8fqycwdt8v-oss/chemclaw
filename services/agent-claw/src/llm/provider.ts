// LlmProvider interface + StubLlmProvider for deterministic tests.
// Real LiteLLM wiring lands in Phase A.2.
// Phase D.2: adds ModelRole for multi-model routing.

import type { Message, StepResult } from "../core/types.js";
import type { Tool } from "../tools/tool.js";

// ---------------------------------------------------------------------------
// Role type — maps to a LiteLLM model alias in config.yaml.
// ---------------------------------------------------------------------------
export type ModelRole = "planner" | "executor" | "compactor" | "judge";

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
// A single chunk emitted by streamCompletion().
// ---------------------------------------------------------------------------
export type StreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; toolId: string; input: unknown }
  | { type: "finish"; finishReason: string; usage: { promptTokens: number; completionTokens: number } };

// ---------------------------------------------------------------------------
// Per-call options shared across LLM provider methods.
// `signal` carries the upstream request lifetime so the SDK can abort the
// HTTP call when a client disconnects mid-stream. `role` selects an alias
// from the multi-model map (planner/executor/compactor/judge); falls back
// to the default AGENT_MODEL when unset.
// ---------------------------------------------------------------------------
export interface LlmCallOptions {
  role?: ModelRole;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// The interface every provider must implement.
// LiteLLMProvider (litellm-provider.ts) is the real implementation.
// StubLlmProvider below is for deterministic tests.
// ---------------------------------------------------------------------------
export interface LlmProvider {
  /**
   * Execute one step: send messages + tool schemas to the model and return
   * a parsed result (text or tool_call) plus token usage.
   *
   * @param opts - Optional call options:
   *   - role: planner/executor/compactor/judge for multi-model routing.
   *   - signal: AbortSignal to cancel the underlying HTTP request when
   *             the upstream client disconnects.
   */
  call(messages: Message[], tools: Tool[], opts?: LlmCallOptions): Promise<LlmResponse>;

  /**
   * Token-by-token streaming variant. Yields StreamChunk objects as they
   * arrive. The final chunk is always a "finish" chunk with usage totals.
   *
   * The harness calls this when the caller requested stream: true and no
   * tool execution is needed for the current step (text-only path). For
   * tool-call steps the harness falls back to call().
   */
  streamCompletion(
    messages: Message[],
    tools: Tool[],
    opts?: LlmCallOptions,
  ): AsyncIterable<StreamChunk>;

  /**
   * Single-turn JSON completion helper.
   * Sends system + user content and JSON.parses the response text.
   * Used for structured output: plan previews, hypothesis drafts, etc.
   */
  completeJson(opts: {
    system: string;
    user: string;
    role?: ModelRole;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// StubLlmProvider — fully deterministic, zero network calls.
// Enqueue responses before a test; each call() dequeues the next one.
// If the queue is empty, throws so tests catch accidental extra calls.
// ---------------------------------------------------------------------------
export class StubLlmProvider implements LlmProvider {
  private readonly _queue: LlmResponse[] = [];

  // Canned chunks to emit on the NEXT streamCompletion() call.
  // Each enqueueStream() call pushes one batch.
  private readonly _streamQueue: StreamChunk[][] = [];

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

  /**
   * Convenience: enqueue a multi-tool_calls step (Phase 5 parallel batch).
   * The harness will run read-only tools in the batch via Promise.all and
   * push one tool message per call into history.
   */
  enqueueToolCalls(
    calls: Array<{ toolId: string; input: unknown }>,
    usage: { promptTokens: number; completionTokens: number } = {
      promptTokens: 10,
      completionTokens: 5,
    },
  ): this {
    return this.enqueue({ result: { kind: "tool_calls", calls }, usage });
  }

  /**
   * Enqueue chunks for the next streamCompletion() call.
   * Pass an array of StreamChunk objects; the stub emits them in order.
   * A "finish" chunk is appended automatically if the provided chunks
   * don't end with one — so basic tests only need to pass text_delta chunks.
   */
  enqueueStream(
    chunks: StreamChunk[],
  ): this {
    // Ensure the batch ends with a finish event.
    const last = chunks[chunks.length - 1];
    if (!last || last.type !== "finish") {
      chunks = [
        ...chunks,
        {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        },
      ];
    }
    this._streamQueue.push(chunks);
    return this;
  }

  /** Number of unconsumed call() responses remaining. */
  get pending(): number {
    return this._queue.length;
  }

  async call(
    _messages: Message[],
    _tools: Tool[],
    _opts?: LlmCallOptions,
  ): Promise<LlmResponse> {
    if (_opts?.signal?.aborted) {
      throw _opts.signal.reason ?? new Error("aborted");
    }
    const next = this._queue.shift();
    if (!next) {
      throw new Error(
        "StubLlmProvider: call() invoked but the response queue is empty. " +
          "Did you forget to enqueue a response for this step?",
      );
    }
    return next;
  }

  /**
   * Streaming stub: dequeues from _streamQueue.
   * If the queue is empty, emits a single text_delta "stub response" + finish.
   * Aborts cleanly between chunks if `opts.signal` fires.
   */
  async *streamCompletion(
    _messages: Message[],
    _tools: Tool[],
    _opts?: LlmCallOptions,
  ): AsyncIterable<StreamChunk> {
    const checkAbort = () => {
      if (_opts?.signal?.aborted) {
        throw _opts.signal.reason ?? new Error("aborted");
      }
    };
    checkAbort();
    const batch = this._streamQueue.shift();
    if (batch) {
      for (const chunk of batch) {
        checkAbort();
        yield chunk;
      }
      return;
    }
    // Default (no batch queued): emit a minimal valid stream.
    yield { type: "text_delta", delta: "stub response" };
    yield {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 10 },
    };
  }

  // completeJson stub — returns a pre-enqueued JSON value for structured output tests.
  private readonly _jsonQueue: unknown[] = [];

  enqueueJson(value: unknown): this {
    this._jsonQueue.push(value);
    return this;
  }

  async completeJson(_opts: {
    system: string;
    user: string;
    role?: ModelRole;
    signal?: AbortSignal;
  }): Promise<unknown> {
    if (_opts.signal?.aborted) {
      throw _opts.signal.reason ?? new Error("aborted");
    }
    const next = this._jsonQueue.shift();
    if (next !== undefined) return next;
    // Default: return an empty object so tests that don't care about structured output
    // don't need to enqueue anything.
    return {};
  }
}
