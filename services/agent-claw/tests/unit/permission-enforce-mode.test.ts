// Tests for the "enforce" permission mode.
//
// Phase 3 of the configuration concept (Initiative 5). The enforce mode is
// the production wiring point: routes pass { permissionMode: "enforce" }
// so the permission_request hook actually fires.
//
// 2026-05-08 hardening: when no hook returns a decision, the resolver now
// defaults to ASK (not ALLOW) so the silent-allow path that combined with
// missing PolicyMatchContext.org/project to silently miss org-scoped denies
// is closed. Operators wanting the legacy permissive default add a global
// allow-all policy row.

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import { runHarness } from "../../src/core/harness.js";
import { resolveDecision } from "../../src/core/permissions/resolver.js";
import { defineTool, type Tool } from "../../src/tools/tool.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import type { Message, ToolContext } from "../../src/core/types.js";

const fakeTool: Tool = {
  id: "Bash",
  description: "",
  inputSchema: { jsonSchema: { type: "object" } } as never,
  call: async () => ({ ok: true }),
} as unknown as Tool;

const fakeCtx: ToolContext = {} as unknown as ToolContext;

describe("permissionMode='enforce'", () => {
  it("asks when no policy hook returns a decision (was: allow pre-fix)", async () => {
    const lifecycle = new Lifecycle();
    const r = await resolveDecision({
      tool: fakeTool,
      input: {},
      ctx: fakeCtx,
      options: { permissionMode: "enforce" },
      lifecycle,
    });
    expect(r.decision).toBe("ask");
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

// Integration-shaped: drives the full harness so the run-one-tool handling
// of the resolver's "ask" decision is exercised. The resolver's contract
// (no-policy-match → ask) is paired with the consumer treating ask as
// fail-closed. Without this pairing, an enforce-mode call with no matching
// permission policy silently executed — see resolver.ts comment.
describe("run-one-tool: enforce-mode 'ask' fails closed", () => {
  it("a tool call with no matching policy returns a synthetic deny envelope", async () => {
    const tool: Tool = defineTool({
      id: "query_kg",
      description: "stub",
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.unknown(),
      annotations: { readOnly: true },
      execute: vi.fn().mockResolvedValue({ ok: true }),
    });

    const llm = new StubLlmProvider()
      .enqueueToolCall("query_kg", { q: "x" })
      .enqueueText("done");

    const ctx: ToolContext = {
      userEntraId: "test@example.com",
      scratchpad: new Map(),
      seenFactIds: new Set(),
    };
    const messages: Message[] = [{ role: "user", content: "go" }];

    await runHarness({
      messages,
      tools: [tool],
      llm,
      budget: new Budget({ maxSteps: 5 }),
      lifecycle: new Lifecycle(),
      ctx,
      permissions: { permissionMode: "enforce" },
    });

    // The tool's execute MUST NOT have run — fail-closed means the resolver
    // short-circuits at run-one-tool BEFORE the tool function is invoked.
    expect(tool.execute).not.toHaveBeenCalled();

    // The harness pushed a synthetic tool message with the deny envelope.
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse(toolMsg!.content) as { error?: string };
    expect(parsed.error).toBe("denied_by_permissions:ask");
  });
});
