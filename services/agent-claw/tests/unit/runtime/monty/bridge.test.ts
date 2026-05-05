// Bridge tests — verify that external_function calls go through runOneTool,
// honour the allow-list, and surface tool failures as ok=false responses.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool } from "../../../../src/tools/tool.js";
import { Lifecycle } from "../../../../src/core/lifecycle.js";
import { routeExternalCall } from "../../../../src/runtime/monty/bridge.js";
import type { Tool } from "../../../../src/tools/tool.js";
import { makeCtx } from "../../../helpers/make-ctx.js";

function buildEchoTool(id: string): Tool {
  return defineTool({
    id,
    description: `echo ${id}`,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    annotations: { readOnly: true },
    execute: async (_ctx, input) => ({ echoed: input.value.toUpperCase() }),
  });
}

function buildFailingTool(id: string): Tool {
  return defineTool({
    id,
    description: "always fails",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute: async () => {
      throw new Error("boom");
    },
  });
}

function makeRegistry(tools: Tool[]): { get(id: string): Tool | undefined } {
  const map = new Map(tools.map((t) => [t.id, t]));
  return { get: (id) => map.get(id) };
}

describe("routeExternalCall", () => {
  it("dispatches to the tool when allow-listed and returns the parsed output", async () => {
    const tool = buildEchoTool("echo");
    const lifecycle = new Lifecycle();
    const ctx = makeCtx();

    const { response, trace } = await routeExternalCall(
      { type: "external_call", id: 1, name: "echo", args: { value: "hello" } },
      {
        registry: makeRegistry([tool]),
        allowedToolIds: new Set(["echo"]),
        ctx,
        lifecycle,
      },
    );

    expect(response).toEqual({
      type: "external_response",
      id: 1,
      ok: true,
      value: { echoed: "HELLO" },
    });
    expect(trace.toolId).toBe("echo");
    expect(trace.ok).toBe(true);
    expect(trace.errorMessage).toBeUndefined();
  });

  it("rejects calls to tools outside the allow-list before resolution", async () => {
    const allowed = buildEchoTool("allowed");
    const forbidden = buildEchoTool("forbidden");
    const lifecycle = new Lifecycle();

    const { response, trace } = await routeExternalCall(
      {
        type: "external_call",
        id: 2,
        name: "forbidden",
        args: { value: "x" },
      },
      {
        registry: makeRegistry([allowed, forbidden]),
        allowedToolIds: new Set(["allowed"]),
        ctx: makeCtx(),
        lifecycle,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain("not in allowed_tools");
    expect(trace.ok).toBe(false);
  });

  it("returns ok=false when the tool itself throws — script can recover", async () => {
    const tool = buildFailingTool("bad");
    const lifecycle = new Lifecycle();

    const { response, trace } = await routeExternalCall(
      { type: "external_call", id: 3, name: "bad", args: {} },
      {
        registry: makeRegistry([tool]),
        allowedToolIds: new Set(["bad"]),
        ctx: makeCtx(),
        lifecycle,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toBe("boom");
    expect(trace.ok).toBe(false);
    expect(trace.errorMessage).toBe("boom");
  });

  it("surfaces a permission-deny payload as ok=false (script sees the structured error)", async () => {
    const tool = buildEchoTool("gated");
    const lifecycle = new Lifecycle();

    const { response, trace } = await routeExternalCall(
      { type: "external_call", id: 4, name: "gated", args: { value: "x" } },
      {
        registry: makeRegistry([tool]),
        allowedToolIds: new Set(["gated"]),
        ctx: makeCtx(),
        lifecycle,
        permissions: {
          permissionMode: "dontAsk",
          // No allowedTools entry → resolver returns "deny".
        },
      },
    );

    expect(response.ok).toBe(false);
    expect(trace.ok).toBe(false);
    expect(trace.errorMessage).toMatch(/denied_by_/);
  });

  it("dispatches pre_tool / post_tool hooks for each external call", async () => {
    const tool = buildEchoTool("hooked");
    const lifecycle = new Lifecycle();
    const preCalls: string[] = [];
    const postCalls: string[] = [];

    lifecycle.on("pre_tool", "test-pre", async (payload) => {
      preCalls.push(payload.toolId);
      return { hookSpecificOutput: {} };
    });
    lifecycle.on("post_tool", "test-post", async (payload) => {
      postCalls.push(payload.toolId);
      return { hookSpecificOutput: {} };
    });

    await routeExternalCall(
      { type: "external_call", id: 5, name: "hooked", args: { value: "y" } },
      {
        registry: makeRegistry([tool]),
        allowedToolIds: new Set(["hooked"]),
        ctx: makeCtx(),
        lifecycle,
      },
    );

    expect(preCalls).toEqual(["hooked"]);
    expect(postCalls).toEqual(["hooked"]);
  });

  it("rejects when the tool is not in the registry", async () => {
    const lifecycle = new Lifecycle();

    const { response, trace } = await routeExternalCall(
      { type: "external_call", id: 6, name: "ghost", args: {} },
      {
        registry: makeRegistry([]),
        allowedToolIds: new Set(["ghost"]),
        ctx: makeCtx(),
        lifecycle,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain("not registered");
    expect(trace.ok).toBe(false);
  });
});
