// Process-wide singleton accessor for the Monty WarmChildPool.
//
// The pool is created lazily on the first call so an agent process where
// monty is disabled never spawns runner children. Once created the
// promise is cached for the process lifetime.
//
// Why a singleton (not constructed in buildDependencies):
//   loadMontyLimits is async, buildDependencies is sync, and the pool size
//   / binary path live in config_settings (per-tenant precedence with
//   global fallback). The bootstrap path resolves them once at the global
//   scope here; per-tenant overrides still flow through the per-call
//   loadMontyLimits inside the builtin (used for wallTimeMs etc.).
//
// Lifecycle: bootstrap kicks getOrCreateMontyPool early (fire-and-forget)
// so the pool warms in the background while the server binds; shutdown
// hooks call shutdownMontyPool() to terminate idle children.

import type { ConfigRegistry } from "../../config/registry.js";
import { defaultChildFactory } from "./child-adapter.js";
import { loadMontyLimits } from "./limits.js";
import { WarmChildPool } from "./pool.js";
import { getLogger } from "../../observability/logger.js";

let poolPromise: Promise<WarmChildPool | undefined> | undefined;
let createdPool: WarmChildPool | undefined;

export function getOrCreateMontyPool(
  configRegistry: ConfigRegistry,
): Promise<WarmChildPool | undefined> {
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    const log = getLogger("agent-claw.runtime.monty.pool-singleton");
    let limits;
    try {
      limits = await loadMontyLimits(configRegistry, {});
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "could not resolve monty limits — pool disabled this process",
      );
      return undefined;
    }
    if (!limits.enabled || !limits.binaryPath || limits.warmPoolSize === 0) {
      log.info(
        {
          event: "monty_pool_skipped",
          enabled: limits.enabled,
          has_binary_path: Boolean(limits.binaryPath),
          warm_pool_size: limits.warmPoolSize,
        },
        "monty pool not initialized (disabled, no binary, or size=0)",
      );
      return undefined;
    }
    const pool = new WarmChildPool({
      factory: defaultChildFactory({ binaryPath: limits.binaryPath }),
      size: limits.warmPoolSize,
    });
    createdPool = pool;
    log.info(
      {
        event: "monty_pool_created",
        size: limits.warmPoolSize,
      },
      "monty warm child pool initialized",
    );
    return pool;
  })();
  return poolPromise;
}

export function shutdownMontyPool(): void {
  if (createdPool) {
    try {
      createdPool.shutdown();
    } catch {
      // best effort
    }
    createdPool = undefined;
  }
  poolPromise = undefined;
}

/** Test-only — clears cached state between vitest runs. */
export function _resetMontyPoolForTests(): void {
  shutdownMontyPool();
}
