// LiteLLMProvider — real implementation of LlmProvider.
//
// Routes every call through the LiteLLM gateway (OpenAI-compatible endpoint).
// The gateway applies the redactor callback BEFORE the prompt leaves the cluster.
//
// Translation layer:
//   harness Message[]   → AI SDK ModelMessage[]
//   harness Tool[]      → AI SDK ToolSet (function-calling schema, inputSchema)
//   AI SDK FinishReason → harness StepResult discriminated union
//
// completeJson() is a single-turn helper for structured output; it wraps
// generateText + JSON.parse. Callers in Phase B+ use it for plan-mode previews
// and hypothesis drafting.
//
// Migrated from AI SDK 4 → 5:
//   - createOpenAI({ compatibility: "compatible" }) → createOpenAICompatible({...})
//   - parameters → inputSchema (tool definition)
//   - args → input (tool call)
//   - result → output (tool result message part)
//   - CoreMessage → ModelMessage; CoreTool → ToolSet/Tool
//   - maxTokens → maxOutputTokens
//   - usage.promptTokens/completionTokens → usage.inputTokens/outputTokens

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, tool } from "ai";
import type { Config } from "../config.js";
import type { LlmProvider, LlmResponse, ModelRole, StreamChunk } from "./provider.js";
import type { Message } from "../core/types.js";
import type { Tool } from "../tools/tool.js";
import type { ModelMessage, ToolSet } from "ai";

// ---------------------------------------------------------------------------
// Internal helper: translate harness Message[] → AI SDK ModelMessage[].
// ---------------------------------------------------------------------------

function toAiSdkMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "tool") {
      // v5 tool-result part uses `output` (was `result` in v4) and accepts
      // a structured output object. We pass the raw string in `output: { type: "json", value: ... }`
      // so it round-trips reliably regardless of the underlying provider.
      let parsed: unknown = m.content;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        // Not JSON — keep the raw string.
      }
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolId ?? "unknown",
            toolName: m.toolId ?? "unknown",
            output: { type: "json", value: parsed as Parameters<typeof JSON.stringify>[0] },
          },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

// ---------------------------------------------------------------------------
// Internal helper: translate harness Tool[] → AI SDK ToolSet (v5 shape).
//
// In v5 the field is `inputSchema` (was `parameters`), and the recommended
// idiom is the `tool({...})` helper which preserves type inference for the
// optional `execute` callback. ChemClaw doesn't supply `execute` here — the
// agent harness runs the tool itself after receiving the model's tool call —
// so the shape is description + inputSchema only.
// ---------------------------------------------------------------------------

function toAiSdkTools(tools: Tool[]): ToolSet {
  const result: ToolSet = {};
  for (const t of tools) {
    result[t.id] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Role → model ID mapping
// ---------------------------------------------------------------------------

type RoleModelMap = {
  [K in ModelRole]: string;
};

export class LiteLLMProvider implements LlmProvider {
  private readonly _factory: ReturnType<typeof createOpenAICompatible>;
  private readonly _defaultModelId: string;
  private readonly _roleMap: RoleModelMap;

  constructor(cfg: Pick<Config,
    "LITELLM_BASE_URL" | "LITELLM_API_KEY" | "AGENT_MODEL" |
    "AGENT_MODEL_PLANNER" | "AGENT_MODEL_EXECUTOR" | "AGENT_MODEL_COMPACTOR" | "AGENT_MODEL_JUDGE"
  >) {
    // LiteLLM exposes an OpenAI-compatible endpoint but isn't strictly OpenAI
    // (no `OpenAI-Organization` header, occasional non-strict response shape).
    // v5 removed the `compatibility: "compatible"` escape hatch from
    // @ai-sdk/openai; the canonical replacement is @ai-sdk/openai-compatible.
    this._factory = createOpenAICompatible({
      name: "litellm",
      baseURL: `${cfg.LITELLM_BASE_URL.replace(/\/$/, "")}/v1`,
      apiKey: cfg.LITELLM_API_KEY,
    });
    this._defaultModelId = cfg.AGENT_MODEL;
    this._roleMap = {
      planner: cfg.AGENT_MODEL_PLANNER,
      executor: cfg.AGENT_MODEL_EXECUTOR,
      compactor: cfg.AGENT_MODEL_COMPACTOR,
      judge: cfg.AGENT_MODEL_JUDGE,
    };
  }

  /** Resolve a model ID from an optional role. Defaults to AGENT_MODEL. */
  private _resolveModel(role?: ModelRole): string {
    if (!role) return this._defaultModelId;
    return this._roleMap[role] ?? this._defaultModelId;
  }

  async call(messages: Message[], tools: Tool[], role?: ModelRole): Promise<LlmResponse> {
    const sdkMessages = toAiSdkMessages(messages);
    const sdkTools = tools.length > 0 ? toAiSdkTools(tools) : undefined;

    const result = await generateText({
      model: this._factory(this._resolveModel(role)),
      messages: sdkMessages,
      tools: sdkTools,
      maxOutputTokens: 4_096,
    });

    // v5 usage shape: inputTokens / outputTokens (was promptTokens/completionTokens).
    const usage = {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    };

    // Check for tool calls first (finishReason may be 'tool-calls' or the
    // model may stop with both tool calls and text in some provider variants).
    if (result.toolCalls && result.toolCalls.length > 0) {
      // Phase 5: when the model emits 2+ tool calls in one assistant
      // message, return the multi-call shape so step.ts can run them as a
      // batch (read-only batches go through Promise.all). Single calls keep
      // the legacy shape so existing tests / callers that pattern-match on
      // kind === "tool_call" continue to work.
      if (result.toolCalls.length > 1) {
        return {
          result: {
            kind: "tool_calls",
            calls: result.toolCalls.map((tc) => ({
              toolId: tc.toolName,
              input: tc.input,
            })),
          },
          usage,
        };
      }
      const first = result.toolCalls[0];
      if (!first) {
        // unreachable: we just checked toolCalls.length > 0 above.
        throw new Error("litellm: empty tool_calls array after non-empty check");
      }
      // v5 renamed args → input on tool-call parts.
      return {
        result: {
          kind: "tool_call",
          toolId: first.toolName,
          input: first.input,
        },
        usage,
      };
    }

    return {
      result: { kind: "text", text: result.text },
      usage,
    };
  }

  /**
   * Token-by-token streaming variant. Uses AI SDK's streamText().
   *
   * Yields:
   *   - text_delta  for each text chunk the model streams
   *   - tool_call   if the model's first tool call appears (streaming stops)
   *   - finish      always as the last chunk (with usage totals)
   */
  async *streamCompletion(
    messages: Message[],
    tools: Tool[],
    role?: ModelRole,
  ): AsyncIterable<StreamChunk> {
    const sdkMessages = toAiSdkMessages(messages);
    const sdkTools = tools.length > 0 ? toAiSdkTools(tools) : undefined;

    const result = streamText({
      model: this._factory(this._resolveModel(role)),
      messages: sdkMessages,
      tools: sdkTools,
      maxOutputTokens: 4_096,
    });

    // Stream text deltas token-by-token.
    for await (const chunk of result.textStream) {
      if (chunk) {
        yield { type: "text_delta", delta: chunk };
      }
    }

    // After the text stream completes, resolve the async fields.
    const [toolCalls, usage, finishReason] = await Promise.all([
      result.toolCalls,
      result.usage,
      result.finishReason,
    ]);

    // Emit tool_call if the model switched to tool use during streaming.
    if (toolCalls && toolCalls.length > 0) {
      const first = toolCalls[0];
      if (first) {
        yield {
          type: "tool_call",
          toolId: first.toolName,
          input: first.input,
        };
      }
    }

    yield {
      type: "finish",
      finishReason: finishReason ?? "stop",
      usage: {
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
      },
    };
  }

  /**
   * Single-turn JSON completion.
   * Sends system + user messages and JSON.parses the response text.
   */
  async completeJson(opts: { system: string; user: string; role?: ModelRole }): Promise<unknown> {
    const result = await generateText({
      model: this._factory(this._resolveModel(opts.role)),
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      maxOutputTokens: 4_000,
    });
    return JSON.parse(result.text);
  }
}
