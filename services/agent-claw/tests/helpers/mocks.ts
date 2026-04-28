// Shared mock factories for agent-claw unit tests.
//
// `mockHookDeps()` returns a HookDeps shape suitable for tests that only
// need to register hooks into a Lifecycle (not dispatch them). The stubbed
// pool / llm / skillLoader fields are throwing Proxies — any property access
// on them during a test fails loud, so we catch the case where a registrar
// starts touching deps at registration time (instead of inside the dispatched
// handler) instead of silently returning `undefined`.

import type { HookDeps } from "../../src/core/hook-loader.js";

/**
 * Build a Proxy that throws on any property access. Used as a stand-in for
 * `pool` / `llm` / `skillLoader` in hook-loader tests where the registrars
 * are wired but never dispatched. If a future registrar starts unwrapping
 * a dep at registration time, this throws with a helpful message instead
 * of letting the test pass on a silent `undefined`.
 *
 * Symbol.toPrimitive / then / toString / Symbol.toStringTag are exempted so
 * vitest's diff renderer (which may stringify the deps when reporting a
 * failure) and accidental thenable detection don't cause spurious throws.
 */
function throwingStub<T extends object>(label: string): T {
  return new Proxy({} as object, {
    get(_, prop) {
      if (
        prop === Symbol.toPrimitive ||
        prop === "then" ||
        prop === "toString" ||
        prop === Symbol.toStringTag
      ) {
        return undefined;
      }
      throw new Error(
        `mockHookDeps.${label}.${String(prop)} accessed during test — ` +
          `if a hook needs ${label}, build a real fake or pass it via deps.`,
      );
    },
  }) as T;
}

/**
 * Build a minimal HookDeps stub for hook-loader tests.
 */
export function mockHookDeps(): HookDeps {
  return {
    pool: throwingStub("pool"),
    llm: throwingStub("llm"),
    skillLoader: throwingStub("skillLoader"),
    allTools: [],
    tokenBudget: 100_000,
  };
}
