// Tests for the new "enforce" permission mode.
//
// Phase 3 of the configuration concept (Initiative 5). The enforce mode is
// the production wiring point: routes pass { permissionMode: "enforce" }
// so the permission_request hook actually fires AND a no-decision hook
// allows (vs. the existing "default" mode's deny-on-no-decision).

import { describe, it, expect } from "vitest";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { resolveDecision } from "../../src/core/permissions/resolver.js";
import type { Tool } from "../../src/tools/tool.js";
import type { ToolContext } from "../../src/core/types.js";

const fakeTool: Tool = {
  id: "Bash",
  description: "",
  inputSchema: { jsonSchema: { type: "object" } } as never,
  call: async () => ({ ok: true }),
} as unknown as Tool;

const fakeCtx: ToolContext = {} as unknown as ToolContext;

describe("permissionMode='enforce'", () => {
  it("allows when no policy hook returns a decision", async () => {
    const lifecycle = new Lifecycle();
    const r = await resolveDecision({
      tool: fakeTool,
      input: {},
      ctx: fakeCtx,
      options: { permissionMode: "enforce" },
      lifecycle,
    });
    expect(r.decision).toBe("allow");
    expect(r.reason).toMatch(/no matching policy/);
  });

  it("denies when a hook returns deny", async () => {
    const lifecycle = new Lifecycle();
    lifecycle.on("permission_request", "test-deny", async () => ({
      hookSpecificOutput: {
        hookEventName: "permission_request",
        permissionDecision: "deny",
        permissionDecisionReason: "policy says no",
      },
    }));
    const r = await resolveDecision({
      tool: fakeTool,
      input: {},
      ctx: fakeCtx,
      options: { permissionMode: "enforce" },
      lifecycle,
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/policy says no/);
  });

  it("asks when a hook returns ask", async () => {
    const lifecycle = new Lifecycle();
    lifecycle.on("permission_request", "test-ask", async () => ({
      hookSpecificOutput: {
        hookEventName: "permission_request",
        permissionDecision: "ask",
        permissionDecisionReason: "needs human review",
      },
    }));
    const r = await resolveDecision({
      tool: fakeTool,
      input: {},
      ctx: fakeCtx,
      options: { permissionMode: "enforce" },
      lifecycle,
    });
    expect(r.decision).toBe("ask");
  });

  it("disallowedTools still wins over enforce mode", async () => {
    const lifecycle = new Lifecycle();
    const r = await resolveDecision({
      tool: fakeTool,
      input: {},
      ctx: fakeCtx,
      options: { permissionMode: "enforce", disallowedTools: ["Bash"] },
      lifecycle,
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/disallowedTools/);
  });
});
