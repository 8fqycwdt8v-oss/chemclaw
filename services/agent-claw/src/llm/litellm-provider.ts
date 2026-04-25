// LiteLLMProvider — real implementation of LlmProvider.
//
// Routes every call through the LiteLLM gateway (OpenAI-compatible endpoint).
// The gateway applies the redactor callback BEFORE the prompt leaves the cluster.
//
// Translation layer:
//   harness Message[]   → AI SDK CoreMessage[]
//   harness Tool[]      → AI SDK ToolSet (function-calling schema)
//   AI SDK FinishReason → harness StepResult discriminated union
//
// completeJson() is a single-turn helper for structured output; it wraps
// generateText + JSON.parse. Callers in Phase B+ use it for plan-mode previews
// and hypothesis drafting.

import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import type { Config } from "../config.js";
import type { LlmProvider, LlmResponse, ModelRole, StreamChunk } from "./provider.js";
import type { Message } from "../core/types.js";
import type { Tool } from "../tools/tool.js";
import type { CoreMessage, CoreTool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Internal helper: translate harness Message[] → AI SDK CoreMessage[].
// ---------------------------------------------------------------------------

function toAiSdkMessages(messages: Message[]): CoreMessage[] {
  return messages.map((m): CoreMessage => {
    if (m.role === "tool") {
      // AI SDK expects tool results as an array of ToolResultPart objects.
      // The field is `result` (not `content`) per the AI SDK schema.
      return {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: m.toolId ?? "unknown",
            toolName: m.toolId ?? "unknown",
            result: m.content,
          },
        ],
      };
    }
    return { role: m.role, content: m.content } as CoreMessage;
  });
}

// ---------------------------------------------------------------------------
// Internal helper: translate harness Tool[] → AI SDK tool definitions.
// ---------------------------------------------------------------------------

function toAiSdkTools(tools: Tool[]): Record<string, CoreTool> {
  const result: Record<string, CoreTool> = {};
  for (const tool of tools) {
    result[tool.id] = {
      description: tool.description,
      // Use the tool's inputSchema directly as the AI SDK parameters.
      // AI SDK accepts Zod schemas; cast through unknown to satisfy TypeScript.
      parameters: tool.inputSchema as z.ZodType<unknown>,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// LiteLLMProvider
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Role → model ID mapping
// ---------------------------------------------------------------------------

type RoleModelMap = {
  [K in ModelRole]: string;
};

export class LiteLLMProvider implements LlmProvider {
  private readonly _factory: ReturnType<typeof createOpenAI>;
  private readonly _defaultModelId: string;
  private readonly _roleMap: RoleModelMap;

  constructor(cfg: Pick<Config,
    "LITELLM_BASE_URL" | "LITELLM_API_KEY" | "AGENT_MODEL" |
    "AGENT_MODEL_PLANNER" | "AGENT_MODEL_EXECUTOR" | "AGENT_MODEL_COMPACTOR" | "AGENT_MODEL_JUDGE"
  >) {
    this._factory = createOpenAI({
      baseURL: `${cfg.LITELLM_BASE_URL.replace(/\/$/, "")}/v1`,
      apiKey: cfg.LITELLM_API_KEY,
      // Avoid sending the optional `OpenAI-Organization` header.
      compatibility: "compatible",
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
      maxTokens: 4_096,
    });

    const usage = {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    };

    // Check for tool calls first (finishReason may be 'tool-calls' or the
    // model may stop with both tool calls and text in some provider variants).
    if (result.toolCalls && result.toolCalls.length > 0) {
      const first = result.toolCalls[0]!;
      return {
        result: {
          kind: "tool_call",
          toolId: first.toolName,
          input: first.args,
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
   *
   * Note on granularity: AI SDK's streamText emits chunks roughly per-token
   * for most providers. Some providers batch tokens into larger chunks (e.g.
   * Claude may emit per-sentence). The harness surfaces whatever the provider
   * sends — no artificial splitting is done.
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
      maxTokens: 4_096,
    });

    // Stream text deltas token-by-token.
    // AI SDK's textStream yields string chunks (empty strings are skipped).
    for await (const chunk of result.textStream) {
      if (chunk) {
        yield { type: "text_delta", delta: chunk };
      }
    }

    // After the text stream completes, resolve the async fields.
    // These are Promises on the StreamTextResult (not on a "finalResult" object).
    const [toolCalls, usage, finishReason] = await Promise.all([
      result.toolCalls,
      result.usage,
      result.finishReason,
    ]);

    // Emit tool_call if the model switched to tool use during streaming.
    if (toolCalls && toolCalls.length > 0) {
      const first = toolCalls[0]!;
      yield {
        type: "tool_call",
        toolId: first.toolName,
        input: first.args,
      };
    }

    yield {
      type: "finish",
      finishReason: finishReason ?? "stop",
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      },
    };
  }

  /**
   * Single-turn JSON completion.
   * Sends system + user messages and JSON.parses the response text.
   * Used for structured-output tasks (plan-mode previews, hypothesis drafts, etc.)
   */
  async completeJson(opts: { system: string; user: string; role?: ModelRole }): Promise<unknown> {
    const result = await generateText({
      model: this._factory(this._resolveModel(opts.role)),
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      maxTokens: 4_000,
    });
    return JSON.parse(result.text);
  }
}
