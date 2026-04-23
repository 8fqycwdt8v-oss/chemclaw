// Mastra-based autonomous reasoning loop.
//
// This is the heart of the Control Flow Philosophy: the model picks tools,
// decides when it's done, and writes a final answer. No DAG. The Agent class
// handles the ReAct loop internally; we just register tools + system prompt
// + model, and the framework orchestrates.
//
// Streaming is surfaced via AsyncGenerator-of-chunks so the transport layer
// (Fastify SSE) can forward to the frontend without this module knowing
// anything about HTTP.

import { Agent } from "@mastra/core/agent";
import type { Pool } from "pg";
import { z } from "zod";

import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { McpDrfpClient, McpEmbedderClient, McpRdkitClient } from "../mcp-clients.js";
import { PromptRegistry } from "./prompts.js";
import { buildTools, type ToolContext } from "./tools.js";

// ---- wire-level shapes ----------------------------------------------------

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(0).max(80_000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export interface ChatInvocation {
  userEntraId: string;
  messages: ChatMessage[];
}

export interface ToolCallEvent {
  type: "tool_call";
  toolId: string;
  input: unknown;
}
export interface ToolResultEvent {
  type: "tool_result";
  toolId: string;
  output: unknown;
}
export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}
export interface FinishEvent {
  type: "finish";
  finishReason: string;
  usage: { promptTokens?: number; completionTokens?: number };
  promptVersion: number;
}
export interface ErrorEvent {
  type: "error";
  error: string;
}
export type StreamEvent =
  | TextDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | FinishEvent
  | ErrorEvent;

// ---- agent factory --------------------------------------------------------

export interface ChatAgentDeps {
  config: Config;
  pool: Pool;
  llm: LlmProvider;
  drfp: McpDrfpClient;
  rdkit: McpRdkitClient;
  embedder: McpEmbedderClient;
  prompts: PromptRegistry;
}

export class ChatAgent {
  constructor(private readonly deps: ChatAgentDeps) {}

  /** Non-streaming variant: run the loop to completion and return the text. */
  async generate(
    invocation: ChatInvocation,
  ): Promise<{ text: string; finishReason: string; promptVersion: number }> {
    const { systemPrompt, promptVersion, ctx } = await this._prepare(invocation);
    const agent = this._buildAgent(systemPrompt, ctx);
    const result = await agent.generate(invocation.messages, {
      maxSteps: this.deps.config.AGENT_CHAT_MAX_STEPS,
    });
    return {
      text: result.text ?? "",
      finishReason: result.finishReason ?? "unknown",
      promptVersion,
    };
  }

  /** Streaming variant: yields StreamEvents. Consumer serialises for SSE. */
  async *stream(invocation: ChatInvocation): AsyncGenerator<StreamEvent> {
    let promptVersion = 0;
    let sawFinish = false;
    try {
      const prepared = await this._prepare(invocation);
      promptVersion = prepared.promptVersion;
      const agent = this._buildAgent(prepared.systemPrompt, prepared.ctx);
      const result = await agent.stream(invocation.messages, {
        maxSteps: this.deps.config.AGENT_CHAT_MAX_STEPS,
      });

      // fullStream emits a unified event sequence. We translate each to our
      // own wire-level shape so the frontend doesn't need Mastra/AI-SDK types.
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta": {
            yield { type: "text_delta", delta: part.textDelta };
            break;
          }
          case "tool-call": {
            yield {
              type: "tool_call",
              toolId: part.toolName,
              input: part.args,
            };
            break;
          }
          case "tool-result": {
            yield {
              type: "tool_result",
              toolId: part.toolName,
              output: part.result,
            };
            break;
          }
          case "finish": {
            sawFinish = true;
            yield {
              type: "finish",
              finishReason: part.finishReason,
              usage: {
                promptTokens: part.usage?.promptTokens,
                completionTokens: part.usage?.completionTokens,
              },
              promptVersion,
            };
            break;
          }
          case "error": {
            yield {
              type: "error",
              error: safeErrorString(part.error),
            };
            break;
          }
          // Other event types (step-start, step-finish, reasoning, etc.)
          // are intentionally ignored at this stage — they're valuable for
          // observability but noisy for the UI. Langfuse will capture them
          // via OTel instrumentation in a later sprint.
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: "error", error: safeErrorString(err) };
    } finally {
      if (!sawFinish) {
        // Ensure the client always sees a terminal event so UIs can stop spinners.
        yield {
          type: "finish",
          finishReason: "aborted",
          usage: {},
          promptVersion,
        };
      }
    }
  }

  // ---- internals ----------------------------------------------------------

  private async _prepare(invocation: ChatInvocation) {
    const { template: systemPrompt, version: promptVersion } =
      await this.deps.prompts.getActive("agent.system");

    const ctx: ToolContext = {
      userEntraId: invocation.userEntraId,
      pool: this.deps.pool,
      drfp: this.deps.drfp,
      rdkit: this.deps.rdkit,
      embedder: this.deps.embedder,
    };
    return { systemPrompt, promptVersion, ctx };
  }

  private _buildAgent(systemPrompt: string, ctx: ToolContext): Agent {
    return new Agent({
      name: "chemclaw",
      instructions: systemPrompt,
      model: this.deps.llm.model(),
      tools: buildTools(ctx),
    });
  }
}

function safeErrorString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err.slice(0, 500);
  return "unknown_error";
}
