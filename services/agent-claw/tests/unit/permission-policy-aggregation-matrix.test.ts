// Aggregation matrix + WARN-log assertions for the permission system.
//
// Existing tests (permission-policy-loader.test.ts, permission-enforce-mode.test.ts)
// cover the basic matchers and the enforce-mode resolver branch. This file
// fills two gaps from the 2026-05-08 deep-review BACKLOG:
//
//   (1) Cross-scope aggregation: when GLOBAL allow + ORG deny + PROJECT ask
//       all match the same call, the resolver MUST honour the strongest
//       (deny > ask > allow) regardless of scope ordering.
//   (2) WARN log invariant: enforce mode falling through to "ask" on a
//       no-policy-match call MUST emit a structured warn record bound to
//       component `agent-claw.core.permissions.resolver` so operators can
//       count silent fall-throughs and plan policy coverage.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool, QueryResult } from "pg";
import {
  PermissionPolicyLoader,
  setPermissionPolicyLoader,
  type PolicyDecision,
} from "../../src/core/permissions/policy-loader.js";
import { resolveDecision } from "../../src/core/permissions/resolver.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { permissionHook } from "../../src/core/hooks/permission.js";
import * as logger from "../../src/observability/logger.js";
import type { Tool } from "../../src/tools/tool.js";
import type { ToolContext } from "../../src/core/types.js";

// ---------- shared mocks ----------

interface MockState {
  rows: Array<{
    id: string;
    scope: "global" | "org" | "project";
    scope_id: string;
    decision: PolicyDecision;
    tool_pattern: string;
    argument_pattern: string | null;
    reason: string | null;
    enabled: boolean;
  }>;
}

// Module-level shared state (matches permission-policy-loader.test.ts pattern).
let state: MockState;
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

function row(over: Partial<MockState["rows"][number]>): MockState["rows"][number] {
  return {
    id: "p-default",
    scope: "global",
    scope_id: "",
    decision: "deny",
    tool_pattern: "Bash",
    argument_pattern: null,
    reason: null,
    enabled: true,
    ...over,
  };
}

const fakeTool: Tool = {
  id: "Bash",
  description: "",
  inputSchema: { jsonSchema: { type: "object" } } as never,
  call: async () => ({ ok: true }),
} as unknown as Tool;

const fakeCtx: ToolContext = {
  userEntraId: "u@example.com",
  scratchpad: new Map(),
  seenFactIds: new Set(),
} as unknown as ToolContext;

// ---------- (1) cross-scope aggregation ----------

interface Case {
  g: PolicyDecision | null;
  o: PolicyDecision | null;
  p: PolicyDecision | null;
  expected: PolicyDecision | null;
}

const cases: Case[] = [
  // No-match → null.
  { g: null, o: null, p: null, expected: null },
  // Single-scope hits.
  { g: "allow", o: null, p: null, expected: "allow" },
  { g: null, o: "deny", p: null, expected: "deny" },
  { g: null, o: null, p: "ask", expected: "ask" },
  // Strict deny>ask>allow ordering across scopes.
  { g: "allow", o: "ask", p: "deny", expected: "deny" },
  { g: "deny", o: "allow", p: "ask", expected: "deny" },
  { g: "allow", o: "deny", p: "ask", expected: "deny" },
  { g: "allow", o: "ask", p: null, expected: "ask" },
  { g: "allow", o: null, p: "ask", expected: "ask" },
  { g: null, o: "allow", p: "ask", expected: "ask" },
  // Allow only when nothing stronger matches.
  { g: null, o: "allow", p: "allow", expected: "allow" },
];

describe("PermissionPolicyLoader.match — cross-scope aggregation matrix", () => {
  it.each(cases)(
    "global=$g org=$o project=$p → $expected",
    async ({ g, o, p, expected }) => {
      if (g) state.rows.push(row({ id: `g-${g}`, scope: "global", scope_id: "", decision: g }));
      if (o) state.rows.push(row({ id: `o-${o}`, scope: "org", scope_id: "acme", decision: o }));
      if (p) state.rows.push(row({ id: `p-${p}`, scope: "project", scope_id: "proj1", decision: p }));

      const loader = new PermissionPolicyLoader(pool);
      await loader.refreshIfStale();
      const m = loader.match({
        toolId: "Bash",
        inputJson: "{}",
        org: "acme",
        project: "proj1",
      });
      if (expected === null) {
        expect(m).toBeNull();
      } else {
        expect(m?.decision).toBe(expected);
      }
    },
  );
});

// ---------- (2) WARN log on enforce-mode no-policy fall-through ----------

describe("resolver enforce-mode no-policy fall-through emits WARN", () => {
  it("WARN log fires with event=permission_enforce_no_policy_match and tool_id", async () => {
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
      // Empty lifecycle: no permission_request handler returns a decision,
      // so the resolver hits the no-match fall-through.
      const lifecycle = new Lifecycle();
      const r = await resolveDecision({
        tool: fakeTool,
        input: { cmd: "ls" },
        ctx: fakeCtx,
        options: { permissionMode: "enforce" },
        lifecycle,
      });
      expect(r.decision).toBe("ask");
      expect(getLoggerSpy).toHaveBeenCalledWith(
        "agent-claw.core.permissions.resolver",
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [fields, msg] = warnSpy.mock.calls[0]!;
      expect(fields).toMatchObject({
        event: "permission_enforce_no_policy_match",
        tool_id: "Bash",
      });
      expect(msg).toMatch(/no matching policy/i);
    } finally {
      getLoggerSpy.mockRestore();
    }
  });

  it("does NOT fire WARN when a hook returns a decision", async () => {
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
      const lifecycle = new Lifecycle();
      lifecycle.on("permission_request", "stub-allow", async () => ({
        hookSpecificOutput: {
          hookEventName: "permission_request",
          permissionDecision: "allow",
          permissionDecisionReason: "policy match",
        },
      }));
      const r = await resolveDecision({
        tool: fakeTool,
        input: {},
        ctx: fakeCtx,
        options: { permissionMode: "enforce" },
        lifecycle,
      });
      expect(r.decision).toBe("allow");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      getLoggerSpy.mockRestore();
    }
  });
});

// ---------- (3) End-to-end via the permission hook → resolver chain ----------

describe("permission hook + resolver — composed end-to-end", () => {
  it("resolver returns the loader's decision when both wired together", async () => {
    state.rows.push(row({ id: "rule-1", scope: "global", scope_id: "", decision: "deny" }));
    const loader = new PermissionPolicyLoader(pool);
    setPermissionPolicyLoader(loader);
    try {
      const lifecycle = new Lifecycle();
      lifecycle.on("permission_request", "permission", permissionHook);

      const r = await resolveDecision({
        tool: fakeTool,
        input: { cmd: "ls" },
        ctx: fakeCtx,
        options: { permissionMode: "enforce" },
        lifecycle,
      });
      expect(r.decision).toBe("deny");
    } finally {
      // Reset module-level singleton so adjacent tests don't see our row.
      setPermissionPolicyLoader(null as never);
    }
  });
});
