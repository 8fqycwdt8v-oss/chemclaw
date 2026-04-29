// Lifecycle hook loader bootstrap.
//
// Hard-fails startup if the minimum-expected number of hooks isn't loaded.
// A misconfigured HOOKS_DIR otherwise produces a process that starts
// without redact-secrets / budget-guard / etc., quietly letting compound
// codes through LiteLLM and unbudgeted tool calls through every endpoint.
//
// The MIN_EXPECTED_HOOKS constant is the source-of-truth for the
// "registered hooks" count and must be bumped every time
// BUILTIN_REGISTRARS in core/hook-loader.ts gains an entry.

import type { Pool } from "pg";
import type { LlmProvider } from "../llm/provider.js";
import type { Lifecycle } from "../core/lifecycle.js";
import type { SkillLoader } from "../core/skills.js";
import type { Tool } from "../tools/tool.js";
import { loadHooks, type HookLoadResult } from "../core/hook-loader.js";

/**
 * Minimum number of hooks the production startup expects to be loaded.
 *
 * 11 = 9 pre-rebuild hooks + session-events (Phase 4B) + permission (Phase 6).
 *
 * Bump every time BUILTIN_REGISTRARS gains an entry so a silent failure
 * to load a new hook trips the startup gate instead of quietly downgrading
 * the safety net.
 */
export const MIN_EXPECTED_HOOKS = 11;

export interface HookLoadDeps {
  pool: Pool;
  llm: LlmProvider;
  skillLoader: SkillLoader;
  allTools: Tool[];
  tokenBudget: number;
}

/**
 * Load YAML hooks into the supplied lifecycle and assert the minimum
 * count. Throws on under-load — callers should let the exception abort
 * startup. Returns the HookLoadResult so the caller can log the
 * `registered`, `skipped` summary.
 */
export async function loadAndAssertHooks(
  lifecycle: Lifecycle,
  deps: HookLoadDeps,
): Promise<HookLoadResult> {
  const hookResult = await loadHooks(lifecycle, deps);
  if (hookResult.registered < MIN_EXPECTED_HOOKS) {
    throw new Error(
      `lifecycle hooks under-loaded: registered=${hookResult.registered}, expected>=${MIN_EXPECTED_HOOKS}; ` +
        `check HOOKS_DIR (skipped=${JSON.stringify(hookResult.skipped)})`,
    );
  }
  return hookResult;
}
