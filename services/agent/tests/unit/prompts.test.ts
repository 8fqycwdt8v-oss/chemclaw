// Unit tests for PromptRegistry.
//
// The registry is a caching layer in front of a Postgres table. We inject a
// fake Pool so we can assert cache behaviour and error semantics without
// running a database.

import { describe, it, expect, vi } from "vitest";
import { PromptRegistry } from "../../src/agent/prompts.js";

function fakePool(rows: Array<{ template: string; version: number }>): {
  pool: any;
  queryCalls: number;
  lastArgs: unknown[];
} {
  const state = { queryCalls: 0, lastArgs: [] as unknown[] };
  const pool = {
    query: async (_sql: string, args: unknown[]) => {
      state.queryCalls++;
      state.lastArgs = args;
      return { rows };
    },
  };
  return {
    pool,
    get queryCalls() {
      return state.queryCalls;
    },
    get lastArgs() {
      return state.lastArgs;
    },
  };
}

describe("PromptRegistry", () => {
  it("returns the active row", async () => {
    const f = fakePool([{ template: "hello", version: 3 }]);
    const r = new PromptRegistry(f.pool as any);
    const got = await r.getActive("agent.system");
    expect(got).toEqual({ template: "hello", version: 3 });
  });

  it("passes the prompt name to the SQL query", async () => {
    const f = fakePool([{ template: "x", version: 1 }]);
    const r = new PromptRegistry(f.pool as any);
    await r.getActive("agent.deep_research_mode");
    expect(f.lastArgs).toEqual(["agent.deep_research_mode"]);
  });

  it("caches within TTL — second call does not re-query", async () => {
    const f = fakePool([{ template: "x", version: 1 }]);
    const r = new PromptRegistry(f.pool as any);
    await r.getActive("agent.system");
    await r.getActive("agent.system");
    expect(f.queryCalls).toBe(1);
  });

  it("invalidate() forces a re-fetch", async () => {
    const f = fakePool([{ template: "x", version: 1 }]);
    const r = new PromptRegistry(f.pool as any);
    await r.getActive("agent.system");
    r.invalidate();
    await r.getActive("agent.system");
    expect(f.queryCalls).toBe(2);
  });

  it("throws if no active prompt registered", async () => {
    const f = fakePool([]);
    const r = new PromptRegistry(f.pool as any);
    await expect(r.getActive("agent.system")).rejects.toThrow(/no active prompt/);
  });
});
