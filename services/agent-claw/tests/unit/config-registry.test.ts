// Tests for services/agent-claw/src/config/registry.ts
//
// Phase 2 of the configuration concept (Initiative 1).

import { describe, it, expect, beforeEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import { ConfigRegistry } from "../../src/config/registry.js";

interface MockState {
  // Map from JSON.stringify([key, user, project, org]) → resolved value
  values: Map<string, unknown>;
  // Counts how many times resolve_config_setting was called (for cache tests)
  callCount: number;
}

function makePool(state: MockState): Pool {
  return {
    connect: async () => ({
      query: async <T = unknown>(
        sql: string,
        params?: unknown[],
      ): Promise<QueryResult<T>> => {
        if (
          sql.startsWith("BEGIN") ||
          sql.startsWith("COMMIT") ||
          sql.startsWith("ROLLBACK") ||
          sql.startsWith("SELECT set_config")
        ) {
          return { rows: [] as T[], rowCount: 0, command: "SET", oid: 0, fields: [] };
        }
        if (sql.includes("resolve_config_setting")) {
          state.callCount++;
          const k = JSON.stringify(params ?? []);
          const value = state.values.has(k) ? state.values.get(k) : null;
          return {
            rows: [{ value }] as unknown as T[],
            rowCount: 1,
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

beforeEach(() => {
  state = { values: new Map(), callCount: 0 };
  pool = makePool(state);
});

describe("ConfigRegistry.get", () => {
  it("returns the default when no row exists", async () => {
    const reg = new ConfigRegistry(pool);
    const v = await reg.get("missing.key", {}, "fallback");
    expect(v).toBe("fallback");
  });

  it("returns the resolved value when present at global scope", async () => {
    state.values.set(JSON.stringify(["agent.max_active_skills", null, null, null]), 16);
    const reg = new ConfigRegistry(pool);
    const v = await reg.get("agent.max_active_skills", {}, 8);
    expect(v).toBe(16);
  });

  it("passes user / project / org context to the SQL function", async () => {
    state.values.set(
      JSON.stringify(["agent.budget", "alice@x.com", "p-1", "acme"]),
      { tokens: 999 },
    );
    const reg = new ConfigRegistry(pool);
    const v = await reg.get<{ tokens: number }>(
      "agent.budget",
      { user: "alice@x.com", project: "p-1", org: "acme" },
      { tokens: 0 },
    );
    expect(v).toEqual({ tokens: 999 });
  });

  it("caches values for ~60s — second read does not hit the DB", async () => {
    state.values.set(JSON.stringify(["k", null, null, null]), 42);
    const reg = new ConfigRegistry(pool, 60_000);
    await reg.get("k", {}, 0);
    await reg.get("k", {}, 0);
    await reg.get("k", {}, 0);
    expect(state.callCount).toBe(1);
  });

  it("invalidate(key) drops only that key's entries", async () => {
    state.values.set(JSON.stringify(["k1", null, null, null]), 1);
    state.values.set(JSON.stringify(["k2", null, null, null]), 2);
    const reg = new ConfigRegistry(pool);
    await reg.get("k1", {}, 0);
    await reg.get("k2", {}, 0);
    expect(state.callCount).toBe(2);

    reg.invalidate("k1");
    await reg.get("k1", {}, 0);
    await reg.get("k2", {}, 0);
    expect(state.callCount).toBe(3); // k2 still cached, k1 re-fetched
  });

  it("invalidate() with no arg drops everything", async () => {
    state.values.set(JSON.stringify(["k1", null, null, null]), 1);
    state.values.set(JSON.stringify(["k2", null, null, null]), 2);
    const reg = new ConfigRegistry(pool);
    await reg.get("k1", {}, 0);
    await reg.get("k2", {}, 0);

    reg.invalidate();
    await reg.get("k1", {}, 0);
    await reg.get("k2", {}, 0);
    expect(state.callCount).toBe(4);
  });

  it("expires the cache after the TTL elapses", async () => {
    state.values.set(JSON.stringify(["k", null, null, null]), 1);
    const reg = new ConfigRegistry(pool, 1); // 1ms TTL
    await reg.get("k", {}, 0);
    await new Promise((r) => setTimeout(r, 5));
    await reg.get("k", {}, 0);
    expect(state.callCount).toBe(2);
  });
});

describe("ConfigRegistry typed helpers", () => {
  it("getNumber falls back when the stored value is not a number", async () => {
    state.values.set(JSON.stringify(["k", null, null, null]), "not a number");
    const reg = new ConfigRegistry(pool);
    expect(await reg.getNumber("k", {}, 7)).toBe(7);
  });

  it("getNumber returns the stored finite number", async () => {
    state.values.set(JSON.stringify(["k", null, null, null]), 3.14);
    const reg = new ConfigRegistry(pool);
    expect(await reg.getNumber("k", {}, 0)).toBe(3.14);
  });

  it("getNumber rejects NaN / Infinity", async () => {
    state.values.set(JSON.stringify(["k", null, null, null]), Number.POSITIVE_INFINITY);
    const reg = new ConfigRegistry(pool);
    expect(await reg.getNumber("k", {}, 9)).toBe(9);
  });

  it("getBoolean returns only true booleans", async () => {
    state.values.set(JSON.stringify(["k1", null, null, null]), true);
    state.values.set(JSON.stringify(["k2", null, null, null]), "true");
    const reg = new ConfigRegistry(pool);
    expect(await reg.getBoolean("k1", {}, false)).toBe(true);
    expect(await reg.getBoolean("k2", {}, false)).toBe(false); // string, not bool
  });

  it("getString rejects non-strings", async () => {
    state.values.set(JSON.stringify(["k", null, null, null]), 42);
    const reg = new ConfigRegistry(pool);
    expect(await reg.getString("k", {}, "fallback")).toBe("fallback");
  });
});
