// Unified autonomous ReAct loop. One prompt, one tool catalog, no modes.

import { Agent } from "@mastra/core/agent";
import type { Pool } from "pg";
import { z } from "zod";

import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type {
  McpDrfpClient,
  McpEmbedderClient,
  McpKgClient,
  McpRdkitClient,
  McpTabiclClient,
} from "../mcp-clients.js";
import { PromptRegistry } from "./prompts.js";
import { buildTools, type ToolContext } from "./tools.js";

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(0).max(80_000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// Retained for backwards compatibility with routes/chat.ts until Task 10
// removes it. ChatAgent no longer branches on mode — the type is kept so
// the route file compiles unchanged.
export type ChatMode = "default" | "deep_research";

export interface ChatInvocation {
  userEntraId: string;
  messages: ChatMessage[];
  agentTraceId?: string;
  /** @deprecated Retained for routes/chat.ts backwards-compat until Task 10.
   *  ChatAgent no longer branches on mode — the field is accepted and ignored. */
  mode?: ChatMode;
}

export interface ToolCallEvent { type: "tool_call"; toolId: string; input: unknown; }
export interface ToolResultEvent { type: "tool_result"; toolId: string; output: unknown; }
export interface TextDeltaEvent { type: "text_delta"; delta: string; }
export interface FinishEvent {
  type: "finish";
  finishReason: string;
  usage: { promptTokens?: number; completionTokens?: number };
  promptVersion: number;
}
export interface ErrorEvent { type: "error"; error: string; }
export type StreamEvent =
  | TextDeltaEvent | ToolCallEvent | ToolResultEvent | FinishEvent | ErrorEvent;

export interface ChatAgentDeps {
  config: Config;
  pool: Pool;
  llm: LlmProvider;
  drfp: McpDrfpClient;
  rdkit: McpRdkitClient;
  embedder: McpEmbedderClient;
  kg: McpKgClient;
  tabicl: McpTabiclClient;
  prompts: PromptRegistry;
}

export class ChatAgent {
  constructor(private readonly deps: ChatAgentDeps) {}

  async generate(invocation: ChatInvocation) {
    const prepared = await this._prepare(invocation);
    const agent = this._buildAgent(prepared.systemPrompt, prepared.ctx);
    const result = await agent.generate(invocation.messages, {
      maxSteps: this.deps.config.AGENT_CHAT_MAX_STEPS,
    });
    return {
      text: result.text ?? "",
      finishReason: result.finishReason ?? "unknown",
      promptVersion: prepared.promptVersion,
    };
  }

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

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text_delta", delta: part.textDelta };
            break;
          case "tool-call":
            yield { type: "tool_call", toolId: part.toolName, input: part.args };
            break;
          case "tool-result":
            yield { type: "tool_result", toolId: part.toolName, output: part.result };
            break;
          case "finish":
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
          case "error":
            yield { type: "error", error: safeErrorString(part.error) };
            break;
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: "error", error: safeErrorString(err) };
    } finally {
      if (!sawFinish) {
        yield { type: "finish", finishReason: "aborted", usage: {}, promptVersion };
      }
    }
  }

  private async _prepare(invocation: ChatInvocation) {
    const { template: systemPrompt, version: promptVersion } =
      await this.deps.prompts.getActive("agent.system");

    const ctx: ToolContext = {
      userEntraId: invocation.userEntraId,
      pool: this.deps.pool,
      drfp: this.deps.drfp,
      rdkit: this.deps.rdkit,
      embedder: this.deps.embedder,
      kg: this.deps.kg,
      tabicl: this.deps.tabicl,
      seenFactIds: new Set<string>(),
      promptVersion,
      agentTraceId: invocation.agentTraceId,
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
