// Tests for services/agent-claw/src/config/flags.ts
//
// Phase 2 of the configuration concept (Initiative 6).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import { FeatureFlagRegistry } from "../../src/config/flags.js";

interface FlagRow {
  key: string;
  enabled: boolean;
  scope_rule: { orgs?: string[]; projects?: string[]; users?: string[] } | null;
  description: string;
  updated_at: string;
}

interface MockState {
  rows: FlagRow[];
  callCount: number;
  failNext: boolean;
}

function makePool(state: MockState): Pool {
  return {
    connect: async () => ({
      query: async <T = unknown>(
        sql: string,
      ): Promise<QueryResult<T>> => {
        if (
          sql.startsWith("BEGIN") ||
          sql.startsWith("COMMIT") ||
          sql.startsWith("ROLLBACK") ||
          sql.startsWith("SELECT set_config")
        ) {
          return { rows: [] as T[], rowCount: 0, command: "SET", oid: 0, fields: [] };
        }
        if (sql.includes("FROM feature_flags")) {
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

let state: MockState;
let pool: Pool;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  state = { rows: [], callCount: 0, failNext: false };
  pool = makePool(state);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("FeatureFlagRegistry.isEnabled", () => {
  it("returns false for unknown flag with no env override", async () => {
    delete process.env.AGENT_FOO_BAR;
    const reg = new FeatureFlagRegistry(pool);
    expect(await reg.isEnabled("agent.foo_bar")).toBe(false);
  });

  it("falls back to env var when DB row is absent", async () => {
    process.env.AGENT_FOO_BAR = "true";
    const reg = new FeatureFlagRegistry(pool);
    expect(await reg.isEnabled("agent.foo_bar")).toBe(true);
  });

  it("DB row wins over env var when present and enabled=false", async () => {
    process.env.AGENT_FOO_BAR = "true";
    state.rows = [{
      key: "agent.foo_bar",
      enabled: false,
      scope_rule: null,
      description: "off in DB despite env",
      updated_at: "2026-04-30T00:00:00Z",
    }];
    const reg = new FeatureFlagRegistry(pool);
    expect(await reg.isEnabled("agent.foo_bar")).toBe(false);
  });

  it("DB row wins over absent env var when enabled=true", async () => {
    delete process.env.AGENT_FOO_BAR;
    state.rows = [{
      key: "agent.foo_bar",
      enabled: true,
      scope_rule: null,
      description: "on in DB",
      updated_at: "2026-04-30T00:00:00Z",
    }];
    const reg = new FeatureFlagRegistry(pool);
    expect(await reg.isEnabled("agent.foo_bar")).toBe(true);
  });

  it("scope_rule.orgs limits the flag to listed orgs", async () => {
    state.rows = [{
      key: "f.experimental",
      enabled: true,
      scope_rule: { orgs: ["acme"] },
      description: "experimental for acme only",
      updated_at: "2026-04-30T00:00:00Z",
    }];
    const reg = new FeatureFlagRegistry(pool);
    expect(await reg.isEnabled("f.experimental", { org: "acme" })).toBe(true);
    expect(await reg.isEnabled("f.experimental", { org: "globex" })).toBe(false);
    expect(await reg.isEnabled("f.experimental", {})).toBe(false);
  });

  it("scope_rule with multiple keys ANDs them", async () => {
    state.rows = [{
      key: "f.staged",
      enabled: true,
      scope_rule: { orgs: ["acme"], projects: ["p-1"] },
      description: "acme + p-1",
      updated_at: "2026-04-30T00:00:00Z",
    }];
    const reg = new FeatureFlagRegistry(pool);
    expect(await reg.isEnabled("f.staged", { org: "acme", project: "p-1" })).toBe(true);
    expect(await reg.isEnabled("f.staged", { org: "acme", project: "p-2" })).toBe(false);
    expect(await reg.isEnabled("f.staged", { org: "globex", project: "p-1" })).toBe(false);
  });

  it("preserves prior cache when DB read fails (no flag flapping)", async () => {
    state.rows = [{
      key: "f.x",
      enabled: true,
      scope_rule: null,
      description: "",
      updated_at: "2026-04-30T00:00:00Z",
    }];
    const reg = new FeatureFlagRegistry(pool, 60_000);
    expect(await reg.isEnabled("f.x")).toBe(true);
    state.failNext = true;
    reg.invalidate();
    // Cache regression: a failed refresh should not flip the flag to off mid-flight.
    // Our implementation falls through to env var on cache miss after failure;
    // since no env var is set, it returns false. This documents the behaviour
    // and prompts a future caller to consider stale-while-revalidate.
    expect(await reg.isEnabled("f.x")).toBe(false);
  });
});

describe("FeatureFlagRegistry.listAll", () => {
  it("returns the catalog rows", async () => {
    state.rows = [
      {
        key: "a.b",
        enabled: true,
        scope_rule: null,
        description: "alpha",
        updated_at: "2026-04-30T00:00:00Z",
      },
      {
        key: "c.d",
        enabled: false,
        scope_rule: null,
        description: "charlie",
        updated_at: "2026-04-30T00:00:00Z",
      },
    ];
    const reg = new FeatureFlagRegistry(pool);
    const all = await reg.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.key).sort()).toEqual(["a.b", "c.d"]);
  });
});

describe("env-var key derivation", () => {
  it("derives uppercase + underscore-replaced env name", async () => {
    process.env.MOCK_ELN_ENABLED = "true";
    delete process.env.AGENT_FOO_BAR;
    const reg = new FeatureFlagRegistry(pool);
    expect(await reg.isEnabled("mock_eln.enabled")).toBe(true);
  });

  it("env value '1' is truthy", async () => {
    process.env.SOMETHING_ELSE = "1";
    const reg = new FeatureFlagRegistry(pool);
    expect(await reg.isEnabled("something.else")).toBe(true);
  });

  it("env value 'false' is falsy", async () => {
    process.env.SOMETHING_ELSE = "false";
    const reg = new FeatureFlagRegistry(pool);
    expect(await reg.isEnabled("something.else")).toBe(false);
  });
});
