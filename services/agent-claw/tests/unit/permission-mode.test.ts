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
      hookSpecificOutput: {
        hookEventName: "permission_request",
        permissionDecision: "deny",
        permissionDecisionReason: "test policy",
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
    expect(r.reason).toBe("test policy");
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

  // ---------------------------------------------------------------------------
  // Precedence interactions — the resolver's contract is documented as a
  // 7-step ladder. The block above pins individual rungs; the cases below
  // pin what happens when several rungs apply at once.
  // ---------------------------------------------------------------------------

  it("bypassPermissions wins over a disallowedTools match", async () => {
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "bypassPermissions", disallowedTools: ["Bash"] },
      lifecycle: new Lifecycle(),
    });
    // bypass is rung 1; disallowedTools is rung 2.
    expect(r.decision).toBe("allow");
    expect(r.reason).toMatch(/bypass/);
  });

  it("disallowedTools wins over acceptEdits for filesystem-touching tools", async () => {
    const r = await resolveDecision({
      tool: stubTool("Write"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "acceptEdits", disallowedTools: ["Write"] },
      lifecycle: new Lifecycle(),
    });
    // acceptEdits is rung 4; disallowedTools is rung 2 — deny wins.
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/disallowedTools/);
  });

  it("disallowedTools supports trailing-wildcard matches", async () => {
    const r = await resolveDecision({
      tool: stubTool("mcp__github__delete_file"),
      input: {},
      ctx: makeCtx(),
      options: { disallowedTools: ["mcp__github__*"] },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/disallowedTools/);
  });

  it("static allowedTools short-circuits before the enforce-mode hook fires", async () => {
    // The resolver checks allowedTools (rung 3) BEFORE consulting the
    // permission_request hook in enforce mode. Pin that ordering so a hook
    // can never accidentally veto an explicit allowlist match.
    const lc = new Lifecycle();
    let hookFired = false;
    lc.on("permission_request", "spy", async () => {
      hookFired = true;
      return {
        hookSpecificOutput: {
          hookEventName: "permission_request",
          permissionDecision: "deny",
          permissionDecisionReason: "should not reach here",
        },
      };
    });
    const r = await resolveDecision({
      tool: stubTool("query_kg"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "enforce", allowedTools: ["query_kg"] },
      lifecycle: lc,
    });
    expect(r.decision).toBe("allow");
    expect(hookFired).toBe(false);
  });

  it("acceptEdits auto-approves the SDK-alias filesystem tools (Write/Edit/MultiEdit)", async () => {
    for (const id of ["Write", "Edit", "MultiEdit"]) {
      const r = await resolveDecision({
        tool: stubTool(id),
        input: {},
        ctx: makeCtx(),
        options: { permissionMode: "acceptEdits" },
        lifecycle: new Lifecycle(),
      });
      expect(r.decision, `tool=${id}`).toBe("allow");
    }
  });

  it("default mode + hook returning allow yields allow", async () => {
    const lc = new Lifecycle();
    lc.on("permission_request", "policy", async () => ({
      hookSpecificOutput: {
        hookEventName: "permission_request",
        permissionDecision: "allow",
        permissionDecisionReason: "policy approved",
      },
    }));
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "default" },
      lifecycle: lc,
    });
    expect(r.decision).toBe("allow");
    expect(r.reason).toBe("policy approved");
  });

  it("default mode + permissionCallback returning deny yields deny (not the no-callback fallback)", async () => {
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "default", permissionCallback: () => "deny" },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("permissionCallback");
  });

  it("default mode + permissionCallback returning ask yields ask", async () => {
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: { permissionMode: "default", permissionCallback: () => "ask" },
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("ask");
  });

  it("default mode + hook decision short-circuits the permissionCallback", async () => {
    // Hook returns a decision; callback should not be consulted.
    const lc = new Lifecycle();
    lc.on("permission_request", "policy", async () => ({
      hookSpecificOutput: {
        hookEventName: "permission_request",
        permissionDecision: "deny",
        permissionDecisionReason: "hook policy",
      },
    }));
    let callbackFired = false;
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: {
        permissionMode: "default",
        permissionCallback: () => {
          callbackFired = true;
          return "allow";
        },
      },
      lifecycle: lc,
    });
    expect(r.decision).toBe("deny");
    expect(callbackFired).toBe(false);
  });

  it("aggregates multiple hook handlers via deny > ask > allow", async () => {
    // Two handlers on the same lifecycle event: one allows, one denies.
    // The lifecycle aggregator must surface deny.
    const lc = new Lifecycle();
    lc.on("permission_request", "permissive", async () => ({
      hookSpecificOutput: {
        hookEventName: "permission_request",
        permissionDecision: "allow",
        permissionDecisionReason: "permissive policy",
      },
    }));
    lc.on("permission_request", "strict", async () => ({
      hookSpecificOutput: {
        hookEventName: "permission_request",
        permissionDecision: "deny",
        permissionDecisionReason: "strict policy",
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
  });

  it("undefined options falls through to default-mode deny without crashing", async () => {
    // Routes that haven't been migrated to pass an explicit permissions
    // block should NOT throw — the resolver treats absent options as default.
    const r = await resolveDecision({
      tool: stubTool("Bash"),
      input: {},
      ctx: makeCtx(),
      options: undefined,
      lifecycle: new Lifecycle(),
    });
    expect(r.decision).toBe("deny");
  });
});
