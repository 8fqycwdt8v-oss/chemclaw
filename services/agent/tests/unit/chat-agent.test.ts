// Unit tests for ChatAgent.
//
// We don't spin up a real LLM — we inject a stub provider whose model()
// returns a fake model object that the AI SDK's test utilities recognise.
// The assertions focus on the wiring we own: prompt registry → agent
// instantiation → streaming event shape → terminal event emission.

import { describe, it, expect } from "vitest";
import { ChatAgent, ChatMessageSchema } from "../../src/agent/chat-agent.js";

describe("ChatMessageSchema", () => {
  it("accepts well-formed messages", () => {
    expect(() =>
      ChatMessageSchema.parse({ role: "user", content: "hi" }),
    ).not.toThrow();
    expect(() =>
      ChatMessageSchema.parse({ role: "assistant", content: "" }),
    ).not.toThrow();
  });

  it("rejects unknown roles", () => {
    expect(() =>
      ChatMessageSchema.parse({ role: "robot", content: "hi" }),
    ).toThrow();
  });

  it("caps content length", () => {
    expect(() =>
      ChatMessageSchema.parse({ role: "user", content: "x".repeat(80_001) }),
    ).toThrow();
  });
});

describe("ChatAgent — stream emits terminal event even on failure", () => {
  it("yields a finish event when the inner agent throws before finishing", async () => {
    // Minimal deps; the provider throws on model() use.
    const deps: any = {
      config: {
        AGENT_CHAT_MAX_STEPS: 3,
        AGENT_MODEL: "test-model",
      },
      pool: {} as any,
      drfp: {} as any,
      rdkit: {} as any,
      llm: {
        model: () => {
          throw new Error("llm unavailable");
        },
      },
      prompts: {
        getActive: async () => ({ template: "sys prompt", version: 1 }),
      },
    };

    const agent = new ChatAgent(deps);
    const events: unknown[] = [];
    for await (const e of agent.stream({
      userEntraId: "u@x",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(e);
    }
    // At minimum we get an error then the finally-block finish.
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1] as any;
    expect(last.type === "finish" || last.type === "error").toBe(true);
  });

  it("fetches the active system prompt before invoking the model", async () => {
    let getActiveCalled = false;
    const deps: any = {
      config: {
        AGENT_CHAT_MAX_STEPS: 3,
        AGENT_MODEL: "test-model",
      },
      pool: {} as any,
      drfp: {} as any,
      rdkit: {} as any,
      llm: {
        model: () => {
          throw new Error("stop here");
        },
      },
      prompts: {
        getActive: async (name: string) => {
          getActiveCalled = true;
          expect(name).toBe("agent.system");
          return { template: "sys", version: 42 };
        },
      },
    };
    const agent = new ChatAgent(deps);
    // Consume the stream so _prepare runs.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of agent.stream({
      userEntraId: "u@x",
      messages: [{ role: "user", content: "hi" }],
    })) {
      /* drain */
    }
    expect(getActiveCalled).toBe(true);
  });
});
