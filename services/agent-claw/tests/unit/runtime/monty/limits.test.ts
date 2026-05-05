// Limits tests — verify ConfigRegistry resolution, defaults, and clamping.

import { describe, it, expect } from "vitest";
import {
  loadMontyLimits,
  DEFAULT_MONTY_LIMITS,
} from "../../../../src/runtime/monty/limits.js";
import type { ConfigRegistry } from "../../../../src/config/registry.js";

interface FakeRegistryOpts {
  values?: Record<string, unknown>;
}

function fakeRegistry(opts: FakeRegistryOpts = {}): ConfigRegistry {
  const values = opts.values ?? {};
  return {
    async get(key: string, _ctx: unknown, defaultValue: unknown) {
      return key in values ? values[key] : defaultValue;
    },
    async getNumber(key: string, _ctx: unknown, defaultValue: number) {
      const v = values[key];
      return typeof v === "number" ? v : defaultValue;
    },
    async getBoolean(key: string, _ctx: unknown, defaultValue: boolean) {
      const v = values[key];
      return typeof v === "boolean" ? v : defaultValue;
    },
    async getString(key: string, _ctx: unknown, defaultValue: string) {
      const v = values[key];
      return typeof v === "string" ? v : defaultValue;
    },
    invalidate() {},
  } as unknown as ConfigRegistry;
}

describe("loadMontyLimits", () => {
  it("returns defaults when no rows match", async () => {
    const limits = await loadMontyLimits(fakeRegistry(), { user: "u" });
    expect(limits).toEqual(DEFAULT_MONTY_LIMITS);
  });

  it("reads scoped overrides", async () => {
    const limits = await loadMontyLimits(
      fakeRegistry({
        values: {
          "monty.enabled": true,
          "monty.binary_path": "/opt/monty",
          "monty.wall_time_ms": 60_000,
          "monty.max_external_calls": 16,
          "monty.warm_pool_size": 2,
        },
      }),
      { user: "u" },
    );
    expect(limits).toEqual({
      enabled: true,
      binaryPath: "/opt/monty",
      wallTimeMs: 60_000,
      maxExternalCalls: 16,
      warmPoolSize: 2,
    });
  });

  it("clamps wall_time_ms to [1000, 600000]", async () => {
    const low = await loadMontyLimits(
      fakeRegistry({ values: { "monty.wall_time_ms": 1 } }),
      {},
    );
    expect(low.wallTimeMs).toBe(1_000);

    const high = await loadMontyLimits(
      fakeRegistry({ values: { "monty.wall_time_ms": 99_999_999 } }),
      {},
    );
    expect(high.wallTimeMs).toBe(600_000);
  });

  it("clamps max_external_calls to [0, 1024]", async () => {
    const high = await loadMontyLimits(
      fakeRegistry({ values: { "monty.max_external_calls": 5_000 } }),
      {},
    );
    expect(high.maxExternalCalls).toBe(1_024);
  });

  it("clamps warm_pool_size to [0, 32]", async () => {
    const high = await loadMontyLimits(
      fakeRegistry({ values: { "monty.warm_pool_size": 100 } }),
      {},
    );
    expect(high.warmPoolSize).toBe(32);
  });

  it("falls back to default when value is non-numeric", async () => {
    const limits = await loadMontyLimits(
      fakeRegistry({ values: { "monty.wall_time_ms": "not a number" } }),
      {},
    );
    expect(limits.wallTimeMs).toBe(DEFAULT_MONTY_LIMITS.wallTimeMs);
  });
});
