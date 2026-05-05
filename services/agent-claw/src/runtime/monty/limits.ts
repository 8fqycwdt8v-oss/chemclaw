// Resource limits for the Monty orchestration runtime.
//
// All knobs resolve through ConfigRegistry (user → project → org → global,
// 60s TTL) so admins can tune per-tenant without restarts. The defaults are
// conservative: 30s wall-time, 32 external_function calls, 4 warm children
// in the pool, runtime disabled by default until a binary path is set.
//
// Keys (registered in db/init/19_config_settings.sql):
//   monty.enabled               boolean — master switch
//   monty.binary_path           string  — path to the Monty runner binary
//   monty.wall_time_ms          number  — per-script wall-time cap
//   monty.max_external_calls    number  — per-script tool call cap
//   monty.warm_pool_size        number  — pre-spawned children

import type { ConfigRegistry, ConfigContext } from "../../config/registry.js";

export interface MontyLimits {
  enabled: boolean;
  binaryPath: string;
  wallTimeMs: number;
  maxExternalCalls: number;
  warmPoolSize: number;
}

export const DEFAULT_MONTY_LIMITS: MontyLimits = {
  enabled: false,
  binaryPath: "",
  wallTimeMs: 30_000,
  maxExternalCalls: 32,
  warmPoolSize: 4,
};

/**
 * Resolve all monty.* knobs for a given scope context.
 *
 * Defaults match DEFAULT_MONTY_LIMITS. The `enabled` switch is independently
 * gated — when false, the host should refuse to spawn children and the
 * builtin should return a clear "runtime disabled" error so the agent can
 * fall back to sequential ReAct.
 */
export async function loadMontyLimits(
  registry: ConfigRegistry,
  ctx: ConfigContext,
): Promise<MontyLimits> {
  const [enabled, binaryPath, wallTimeMs, maxExternalCalls, warmPoolSize] =
    await Promise.all([
      registry.getBoolean("monty.enabled", ctx, DEFAULT_MONTY_LIMITS.enabled),
      registry.getString("monty.binary_path", ctx, DEFAULT_MONTY_LIMITS.binaryPath),
      registry.getNumber("monty.wall_time_ms", ctx, DEFAULT_MONTY_LIMITS.wallTimeMs),
      registry.getNumber(
        "monty.max_external_calls",
        ctx,
        DEFAULT_MONTY_LIMITS.maxExternalCalls,
      ),
      registry.getNumber(
        "monty.warm_pool_size",
        ctx,
        DEFAULT_MONTY_LIMITS.warmPoolSize,
      ),
    ]);

  return {
    enabled,
    binaryPath,
    // Defense-in-depth: clamp wall-time to a sane range so a misconfigured
    // row can't disable the timeout entirely. Floor matches the script
    // input schema's minimum; ceiling matches the longest expected
    // orchestration (a few minutes of read-only retrieval/rank work).
    wallTimeMs: clamp(wallTimeMs, 1_000, 600_000),
    maxExternalCalls: clamp(maxExternalCalls, 0, 1_024),
    warmPoolSize: clamp(warmPoolSize, 0, 32),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
