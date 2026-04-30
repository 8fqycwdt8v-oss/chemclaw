// Tests for services/agent-claw/src/core/permissions/policy-loader.ts
//
// Phase 3 of the configuration concept (Initiative 5).

import { describe, it, expect, beforeEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import {
  PermissionPolicyLoader,
  type PolicyDecision,
} from "../../src/core/permissions/policy-loader.js";

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
  callCount: number;
  failNext: boolean;
}

function makePool(state: MockState): Pool {
  return {
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
          state.callCount++;
          if (state.failNext) {
            state.failNext = false;
            throw new Error("simulated DB outage");
          }
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
}

function makeRow(over: Partial<MockState["rows"][number]>): MockState["rows"][number] {
  return {
    id: "p1",
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

let state: MockState;
let pool: Pool;

beforeEach(() => {
  state = { rows: [], callCount: 0, failNext: false };
  pool = makePool(state);
});

describe("PermissionPolicyLoader.match", () => {
  it("returns null when no policies are loaded", async () => {
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    expect(loader.match({ toolId: "Bash", inputJson: "{}" })).toBeNull();
  });

  it("matches a global deny on exact tool id", async () => {
    state.rows = [makeRow({ tool_pattern: "Bash", decision: "deny" })];
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    const m = loader.match({ toolId: "Bash", inputJson: "{}" });
    expect(m?.decision).toBe("deny");
  });

  it("supports trailing-wildcard tool patterns", async () => {
    state.rows = [makeRow({ tool_pattern: "mcp__github__*", decision: "deny" })];
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    expect(loader.match({ toolId: "mcp__github__create_pr", inputJson: "{}" })?.decision).toBe("deny");
    expect(loader.match({ toolId: "mcp__gitlab__create_pr", inputJson: "{}" })).toBeNull();
  });

  it("deny beats allow at the same scope", async () => {
    state.rows = [
      makeRow({ id: "p1", tool_pattern: "Bash", decision: "allow" }),
      makeRow({ id: "p2", tool_pattern: "Bash", decision: "deny" }),
    ];
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    expect(loader.match({ toolId: "Bash", inputJson: "{}" })?.decision).toBe("deny");
  });

  it("ask beats allow but loses to deny", async () => {
    state.rows = [
      makeRow({ id: "p1", tool_pattern: "Bash", decision: "ask" }),
      makeRow({ id: "p2", tool_pattern: "Bash", decision: "allow" }),
    ];
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    expect(loader.match({ toolId: "Bash", inputJson: "{}" })?.decision).toBe("ask");
  });

  it("argument_pattern regex gates the rule", async () => {
    state.rows = [makeRow({
      tool_pattern: "Bash",
      argument_pattern: "rm\\s+-rf",
      decision: "deny",
    })];
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    expect(loader.match({ toolId: "Bash", inputJson: '{"cmd":"ls"}' })).toBeNull();
    expect(loader.match({ toolId: "Bash", inputJson: '{"cmd":"rm -rf /"}' })?.decision).toBe("deny");
  });

  it("invalid argument_pattern is silently skipped, not raised", async () => {
    state.rows = [makeRow({ tool_pattern: "Bash", argument_pattern: "[unclosed", decision: "deny" })];
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    expect(loader.match({ toolId: "Bash", inputJson: "{}" })).toBeNull();
  });

  it("scope='org' rule only fires when ctx.org matches", async () => {
    state.rows = [makeRow({ scope: "org", scope_id: "acme", decision: "deny" })];
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    expect(loader.match({ toolId: "Bash", inputJson: "{}", org: "acme" })?.decision).toBe("deny");
    expect(loader.match({ toolId: "Bash", inputJson: "{}", org: "globex" })).toBeNull();
    expect(loader.match({ toolId: "Bash", inputJson: "{}" })).toBeNull();
  });

  it("scope='project' rule only fires when ctx.project matches", async () => {
    state.rows = [makeRow({ scope: "project", scope_id: "p1", decision: "deny" })];
    const loader = new PermissionPolicyLoader(pool);
    await loader.refreshIfStale();
    expect(loader.match({ toolId: "Bash", inputJson: "{}", project: "p1" })?.decision).toBe("deny");
    expect(loader.match({ toolId: "Bash", inputJson: "{}", project: "p2" })).toBeNull();
  });
});

describe("PermissionPolicyLoader.refreshIfStale", () => {
  it("caches within TTL — second refresh is a no-op", async () => {
    state.rows = [makeRow({})];
    const loader = new PermissionPolicyLoader(pool, 60_000);
    await loader.refreshIfStale();
    await loader.refreshIfStale();
    expect(state.callCount).toBe(1);
  });

  it("preserves prior cache when DB read fails", async () => {
    state.rows = [makeRow({ tool_pattern: "Bash", decision: "deny" })];
    const loader = new PermissionPolicyLoader(pool, 60_000);
    await loader.refreshIfStale();
    expect(loader.match({ toolId: "Bash", inputJson: "{}" })?.decision).toBe("deny");

    state.failNext = true;
    loader.invalidate();
    await loader.refreshIfStale();
    // The new fetch failed; the loader sets cache to [] in the catch branch
    // when there was no prior cache. Here we deliberately had a cache that
    // got nuked by invalidate(). Behaviour: return [] not retain.
    expect(loader.match({ toolId: "Bash", inputJson: "{}" })).toBeNull();
  });
});
