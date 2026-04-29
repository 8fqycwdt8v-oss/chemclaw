// pre_turn hook: init-scratch
//
// Initialises per-turn scratch state before any LLM call.
// Currently initialises:
//   seenFactIds — empty Set<string> that the anti-fabrication hook populates
//                 after each tool call. Tools like propose_hypothesis read it
//                 to enforce the hard guard.
//
// Must run BEFORE anti-fabrication (registration order matters — both hooks
// share the pre_turn point and run sequentially).

import type { PreTurnPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";

export async function initScratchHook(
  payload: PreTurnPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  payload.ctx.scratchpad.set("seenFactIds", new Set<string>());
  return {};
}

/**
 * Register the init-scratch hook into a Lifecycle instance.
 * Call before registerAntiFabricationHook so seenFactIds is initialised first.
 */
export function registerInitScratchHook(lifecycle: Lifecycle): void {
  lifecycle.on("pre_turn", "init-scratch", initScratchHook);
}
