// Phase 6: permission resolver tests.
//
// Pins the precedence order (bypass → disallowedTools → allowedTools →
// acceptEdits → plan → dontAsk → default-with-hook-or-callback) plus the
// wildcard-allow shape used for MCP tool fan-out.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { defineTool } from "../../src/tools/tool.js";
import type { Tool } from "../../src/tools/tool.js";
import type { ToolContext } from "../../src/core/types.js";
import { resolveDecision } from "../../src/core/permissions/resolver.js";

function stubTool(id: string): Tool {
  return defineTool({
    id,
    description: `stub for ${id}`,
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.unknown(),
    execute: async () => ({ ok: true }),
  });
}

function makeCtx(): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return {
    userEntraId: "test@example.com",
    scratchpad,
    seenFactIds,
  };
}

describe("permission resolver", () => {
  it("bypassPermissions allows everything", async () => {
    const r = await resolveDecision({
      tool: stubTool("anything"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "bypassPermissions" },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("allow");
  });

  it("disallowedTools denies even if allowedTools matches", async () => {
    const r = await resolveDecision({
      tool: stubTool("Read"),
      input: {},
      ctx: makeCtx(),
      options: { allowedTools: ["Read"], disallowedTools: ["Read"] },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("disallowedTools");
  });

  it("dontAsk denies when no allowedTools match", async () => {
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "dontAsk" },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("deny");
  });

  it("dontAsk allows when allowedTools matches", async () => {
    const r = await resolveDecision({
      tool: stubTool("Read"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "dontAsk", allowedTools: ["Read"] },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("allow");
  });

  it("acceptEdits allows run_program (filesystem tool)", async () => {
    const r = await resolveDecision({
      tool: stubTool("run_program"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "acceptEdits" },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("allow");
  });

  it("acceptEdits denies a non-filesystem tool when no rule matches", async () => {
    const r = await resolveDecision({
      tool: stubTool("query_kg"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "acceptEdits" },
      lifecycle: new Lifecycle(),
    });
    // Falls through to default-mode + no hook + no callback → deny.
    expect(r.decision).toBe("deny");
  });

  it("plan mode returns defer", async () => {
    const r = await resolveDecision({
      tool: stubTool("query_kg"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "plan" },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("defer");
  });

  it("default mode + permission hook returns deny → final is deny", async () => {
    const lc = new Lifecycle();
    lc.on("permission_request", "policy", async () => ({
      decision: "deny" as const,
      reason: "test policy",
    }));
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "default" },
      lifecycle: lc,
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("test policy");
  });

  it("default mode + SDK-shape permission hook (hookSpecificOutput) → deny", async () => {
    // Forward-compatible parity with the Claude Agent SDK hook shape: a
    // permission hook may return { hookSpecificOutput: { permissionDecision } }
    // and the lifecycle aggregator normalises it to a PermissionHookResult.
    const lc = new Lifecycle();
    lc.on("permission_request", "policy", async () => ({
      hookSpecificOutput: {
        hookEventName: "permission_request" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "sdk-shape policy",
      },
    }));
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "default" },
      lifecycle: lc,
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("sdk-shape policy");
  });

  it("default mode + permissionCallback returns allow", async () => {
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "default", permissionCallback: () => "allow" },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("allow");
  });

  it("default mode no callback no hook → deny", async () => {
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "default" },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("deny");
  });

  it("wildcard allowedTools matches mcp__server__action", async () => {
    const r = await resolveDecision({
      tool: stubTool("mcp__github__list_issues"),
      input: {},
      ctx: makeCtx(),
      options: { allowedTools: ["mcp__github__*"] },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("allow");
  });

  it("wildcard prefix that doesn't match → falls through to default deny", async () => {
    const r = await resolveDecision({
      tool: stubTool("mcp__gitlab__list_issues"),
      input: {},
      ctx: makeCtx(),
      options: { allowedTools: ["mcp__github__*"] },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("deny");
  });

  it("multiple permission hooks aggregate via deny>defer>ask>allow", async () => {
    // First hook says allow, second says deny — deny must win.
    const lc = new Lifecycle();
    lc.on("permission_request", "lenient", async () => ({
      decision: "allow" as const,
      reason: "permissive policy",
    }));
    lc.on("permission_request", "strict", async () => ({
      decision: "deny" as const,
      reason: "strict policy",
    }));
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "default" },
      lifecycle: lc,
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("strict policy");
  });
});
