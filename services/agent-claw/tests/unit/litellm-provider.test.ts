// Tests for LiteLLMProvider.
//
// We mock the underlying `generateText` from the "ai" package via vi.mock so
// we avoid any network call. We verify:
//   - request shape (model id forwarded, messages translated, tools translated)
//   - response translation to StepResult (text and tool_call variants)
//   - completeJson round-trip (JSON.parse of model text)
//
// vi.hoisted() is used to declare mocks before the vi.mock factory runs
// (vitest hoists vi.mock calls to the top of the file).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Declare the mock function before vi.mock factories reference it.
// vi.hoisted() ensures this runs before module resolution.
// ---------------------------------------------------------------------------

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock the "ai" package's generateText before importing the provider.
// ---------------------------------------------------------------------------

vi.mock("ai", () => ({
  generateText: generateTextMock,
  // v5 `tool({...})` helper — identity passthrough is enough for these unit tests.
  tool: vi.fn((def: unknown) => def),
}));

// @ai-sdk/openai-compatible (v5 replacement for createOpenAI w/ compatibility flag).
// createOpenAICompatible returns a model factory; we return a passthrough.
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => {
    return vi.fn((modelId: string) => ({ _modelId: modelId }));
  }),
}));

// Import AFTER mocks are in place.
import { LiteLLMProvider } from "../../src/llm/litellm-provider.js";
import type { Message } from "../../src/core/types.js";
import { defineTool } from "../../src/tools/tool.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    LITELLM_BASE_URL: "http://litellm:4000",
    LITELLM_API_KEY: "sk-test",
    AGENT_MODEL: "claude-opus-4-7",
  };
}

function makeMessages(text = "Hello"): Message[] {
  return [{ role: "user", content: text }];
}

const smilesToolDef = defineTool({
  id: "canonicalize_smiles",
  description: "Canonicalize SMILES",
  inputSchema: z.object({ smiles: z.string() }),
  outputSchema: z.object({ canonical_smiles: z.string() }),
  execute: async () => ({ canonical_smiles: "c1ccccc1" }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LiteLLMProvider", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  describe("call() — text response", () => {
    it("returns a text StepResult when the model produces text", async () => {
      generateTextMock.mockResolvedValue({
        text: "Hello from the model",
        toolCalls: [],
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      });

      const provider = new LiteLLMProvider(makeConfig());
      const response = await provider.call(makeMessages(), []);

      expect(response.result.kind).toBe("text");
      if (response.result.kind === "text") {
        expect(response.result.text).toBe("Hello from the model");
      }
    });

    it("returns usage from the AI SDK response", async () => {
      generateTextMock.mockResolvedValue({
        text: "Done",
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      });

      const provider = new LiteLLMProvider(makeConfig());
      const { usage } = await provider.call(makeMessages(), []);

      expect(usage.promptTokens).toBe(100);
      expect(usage.completionTokens).toBe(30);
    });
  });

  describe("call() — tool_call response", () => {
    it("returns a tool_call StepResult when the model calls a tool", async () => {
      generateTextMock.mockResolvedValue({
        text: "",
        toolCalls: [
          {
            toolName: "canonicalize_smiles",
            input: { smiles: "c1ccccc1" },
          },
        ],
        usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
      });

      const provider = new LiteLLMProvider(makeConfig());
      const response = await provider.call(makeMessages(), [smilesToolDef]);

      expect(response.result.kind).toBe("tool_call");
      if (response.result.kind === "tool_call") {
        expect(response.result.toolId).toBe("canonicalize_smiles");
        expect(response.result.input).toEqual({ smiles: "c1ccccc1" });
      }
    });

    it("prefers tool_call over text when both are present", async () => {
      generateTextMock.mockResolvedValue({
        text: "I will call a tool",
        toolCalls: [
          { toolName: "canonicalize_smiles", input: { smiles: "CC" } },
        ],
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      });

      const provider = new LiteLLMProvider(makeConfig());
      const response = await provider.call(makeMessages(), [smilesToolDef]);

      expect(response.result.kind).toBe("tool_call");
    });

    it("passes tool schemas to generateText", async () => {
      generateTextMock.mockResolvedValue({
        text: "ok",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      const provider = new LiteLLMProvider(makeConfig());
      await provider.call(makeMessages(), [smilesToolDef]);

      // generateText is called with a single options object, not spread args.
      const callArgs = generateTextMock.mock.calls[0]?.[0] as
        | { tools?: Record<string, unknown> }
        | undefined;
      expect(callArgs?.tools).toBeDefined();
      expect(callArgs?.tools?.["canonicalize_smiles"]).toBeDefined();
    });
  });

  describe("call() — message translation", () => {
    it("translates tool-role messages to AI SDK tool-result format", async () => {
      generateTextMock.mockResolvedValue({
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      const provider = new LiteLLMProvider(makeConfig());
      const messages: Message[] = [
        { role: "user", content: "canonicalize benzene" },
        {
          role: "tool",
          content: '{"canonical_smiles":"c1ccccc1"}',
          toolId: "canonicalize_smiles",
        },
      ];

      await provider.call(messages, []);

      // generateText is called with a single options object.
      const callArgs = generateTextMock.mock.calls[0]?.[0] as
        | { messages?: unknown[] }
        | undefined;
      const sdkMessages = callArgs?.messages ?? [];
      const toolMsg = sdkMessages.find(
        (m): m is { role: string } => (m as { role: string }).role === "tool",
      );
      expect(toolMsg).toBeDefined();
    });
  });

  describe("completeJson()", () => {
    it("returns parsed JSON from the model's text response", async () => {
      generateTextMock.mockResolvedValue({
        text: '{"plan":["step1","step2"]}',
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      });

      const provider = new LiteLLMProvider(makeConfig());
      const result = await provider.completeJson({
        system: "You are a planner.",
        user: "Draft a plan.",
      });

      expect(result).toEqual({ plan: ["step1", "step2"] });
    });

    it("throws SyntaxError when the model returns non-JSON text", async () => {
      generateTextMock.mockResolvedValue({
        text: "not json at all",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      const provider = new LiteLLMProvider(makeConfig());
      await expect(
        provider.completeJson({ system: "s", user: "u" }),
      ).rejects.toThrow(SyntaxError);
    });
  });
});
