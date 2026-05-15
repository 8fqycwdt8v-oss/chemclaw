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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import { z } from "zod";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import { runHarness } from "../../src/core/harness.js";
import { resolveDecision } from "../../src/core/permissions/resolver.js";
import {
  PermissionPolicyLoader,
  setPermissionPolicyLoader,
  clearPermissionPolicyLoader,
  type PolicyDecision,
} from "../../src/core/permissions/policy-loader.js";
import { permissionHook } from "../../src/core/hooks/permission.js";
import { defineTool, type Tool } from "../../src/tools/tool.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import * as logger from "../../src/observability/logger.js";
import type { Message, ToolContext } from "../../src/core/types.js";
import { makeCtx } from "../helpers/make-ctx.js";

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
// ---------------------------------------------------------------------------
// Task F — org-scoped policy + unbound-ctx WARN
//
// When PolicyMatchContext.org/project were optional, a route that forgot to
// thread orgId into the ToolContext silently failed org-scoped policies. The
// new contract makes both fields required-nullable so the loader sees an
// explicit null, and the resolver WARNs (event: permission_org_scoped_policy
// _unbound_ctx) so operators can wire route-level binding (Phase F.3) BEFORE
// org-scoped policies start landing in production.
// ---------------------------------------------------------------------------
describe("Task F: org-scoped policy unbound-ctx WARN", () => {
  interface RowShape {
    id: string;
    scope: "global" | "org" | "project";
    scope_id: string;
    decision: PolicyDecision;
    tool_pattern: string;
    argument_pattern: string | null;
    reason: string | null;
    enabled: boolean;
  }
  let state: { rows: RowShape[] };
  let pool: Pool;

  beforeEach(() => {
    state = { rows: [] };
    pool = {
      connect: async () => ({
        query: async <T = unknown>(sql: string): Promise<QueryResult<T>> => {
          if (
            sql.startsWith("BEGIN") ||
            sql.startsWith("COMMIT") ||
            sql.startsWith("ROLLBACK") ||
            sql.startsWith("SELECT set_config")
          ) {
            return { rows: [] as T[], rowCount: 0, command: "SET", oid: 0, fields: [] };
          }
          if (sql.includes("FROM permission_policies")) {
            return {
              rows: state.rows as unknown as T[],
              rowCount: state.rows.length,
              command: "SELECT",
              oid: 0,
              fields: [],
            };
          }
          return { rows: [] as T[], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
        },
        release: () => {},
      }),
    } as unknown as Pool;
  });

  afterEach(() => {
    clearPermissionPolicyLoader();
  });

  function policyRow(over: Partial<RowShape>): RowShape {
    return {
      id: "p-test",
      scope: "global",
      scope_id: "",
      decision: "deny",
      tool_pattern: "risky_tool",
      argument_pattern: null,
      reason: null,
      enabled: true,
      ...over,
    };
  }

  async function buildLifecycleWithPolicyHook(): Promise<Lifecycle> {
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    setPermissionPolicyLoader(loader);
    const lifecycle = new Lifecycle();
    lifecycle.on("permission_request", "permission", permissionHook);
    return lifecycle;
  }

  const riskyTool: Tool = {
    id: "risky_tool",
    description: "",
    inputSchema: { jsonSchema: { type: "object" } } as never,
    call: async () => ({ ok: true }),
  } as unknown as Tool;

  it("WARNs when an org-scoped policy could match but ctx.orgId is null", async () => {
    state.rows.push(
      policyRow({
        id: "org-acme-deny",
        scope: "org",
        scope_id: "acme",
        decision: "deny",
        tool_pattern: "risky_tool",
      }),
    );
    const lifecycle = await buildLifecycleWithPolicyHook();

    const warnSpy = vi.fn();
    const stubLogger = {
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => stubLogger,
    };
    const getLoggerSpy = vi
      .spyOn(logger, "getLogger")
      .mockReturnValue(stubLogger as never);

    try {
      const result = await resolveDecision({
        tool: riskyTool,
        input: {},
        ctx: makeCtx("u@example.com", [], { orgId: null }),
        options: { permissionMode: "enforce" },
        lifecycle,
      });
      // Org-scoped policy can't match unbound ctx → no decision → default ask.
      expect(result.decision).toBe("ask");
      // The unbound-ctx WARN fired with the new event name.
      const unboundCall = warnSpy.mock.calls.find(
        (call) =>
          (call[0] as { event?: string }).event ===
          "permission_org_scoped_policy_unbound_ctx",
      );
      expect(unboundCall).toBeDefined();
      expect(unboundCall![0]).toMatchObject({
        event: "permission_org_scoped_policy_unbound_ctx",
        tool_id: "risky_tool",
        policy_count: 1,
      });
    } finally {
      getLoggerSpy.mockRestore();
    }
  });

  it("the same org-scoped policy DOES fire when ctx.orgId matches", async () => {
    state.rows.push(
      policyRow({
        id: "org-acme-deny",
        scope: "org",
        scope_id: "acme",
        decision: "deny",
        tool_pattern: "risky_tool",
        reason: "acme denies risky_tool",
      }),
    );
    const lifecycle = await buildLifecycleWithPolicyHook();

    const result = await resolveDecision({
      tool: riskyTool,
      input: {},
      ctx: makeCtx("u@example.com", [], { orgId: "acme" }),
      options: { permissionMode: "enforce" },
      lifecycle,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/acme denies risky_tool/);
  });

  it("does NOT emit the unbound-ctx WARN when no org-scoped policy could match", async () => {
    // Only a global policy exists; ctx.orgId being null is irrelevant.
    state.rows.push(
      policyRow({
        id: "global-allow",
        scope: "global",
        scope_id: "",
        decision: "allow",
        tool_pattern: "risky_tool",
      }),
    );
    const lifecycle = await buildLifecycleWithPolicyHook();

    const warnSpy = vi.fn();
    const stubLogger = {
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => stubLogger,
    };
    const getLoggerSpy = vi
      .spyOn(logger, "getLogger")
      .mockReturnValue(stubLogger as never);

    try {
      const result = await resolveDecision({
        tool: riskyTool,
        input: {},
        ctx: makeCtx("u@example.com", [], { orgId: null }),
        options: { permissionMode: "enforce" },
        lifecycle,
      });
      expect(result.decision).toBe("allow");
      const unboundCall = warnSpy.mock.calls.find(
        (call) =>
          (call[0] as { event?: string }).event ===
          "permission_org_scoped_policy_unbound_ctx",
      );
      expect(unboundCall).toBeUndefined();
    } finally {
      getLoggerSpy.mockRestore();
    }
  });

  it("WARNs when a project-scoped policy could match but ctx.nceProjectId is null", async () => {
    state.rows.push(
      policyRow({
        id: "project-alpha-deny",
        scope: "project",
        scope_id: "00000000-0000-0000-0000-000000000001",
        decision: "deny",
        tool_pattern: "risky_tool",
      }),
    );
    const lifecycle = await buildLifecycleWithPolicyHook();

    const warnSpy = vi.fn();
    const stubLogger = {
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => stubLogger,
    };
    const getLoggerSpy = vi
      .spyOn(logger, "getLogger")
      .mockReturnValue(stubLogger as never);

    try {
      const result = await resolveDecision({
        tool: riskyTool,
        input: {},
        ctx: makeCtx("u@example.com", [], {
          orgId: null,
          nceProjectId: null,
        }),
        options: { permissionMode: "enforce" },
        lifecycle,
      });
      expect(result.decision).toBe("ask");
      const unboundCall = warnSpy.mock.calls.find(
        (call) =>
          (call[0] as { event?: string }).event ===
          "permission_project_scoped_policy_unbound_ctx",
      );
      expect(unboundCall).toBeDefined();
      expect(unboundCall![0]).toMatchObject({
        event: "permission_project_scoped_policy_unbound_ctx",
        tool_id: "risky_tool",
        policy_count: 1,
      });
    } finally {
      getLoggerSpy.mockRestore();
    }
  });

  it("the same project-scoped policy DOES fire when ctx.nceProjectId matches", async () => {
    state.rows.push(
      policyRow({
        id: "project-alpha-deny",
        scope: "project",
        scope_id: "00000000-0000-0000-0000-000000000001",
        decision: "deny",
        tool_pattern: "risky_tool",
        reason: "alpha project denies risky_tool",
      }),
    );
    const lifecycle = await buildLifecycleWithPolicyHook();

    const result = await resolveDecision({
      tool: riskyTool,
      input: {},
      ctx: makeCtx("u@example.com", [], {
        orgId: null,
        nceProjectId: "00000000-0000-0000-0000-000000000001",
      }),
      options: { permissionMode: "enforce" },
      lifecycle,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/alpha project denies risky_tool/);
  });
});

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
