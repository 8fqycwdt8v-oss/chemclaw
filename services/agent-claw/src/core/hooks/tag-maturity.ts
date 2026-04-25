// post_tool hook: tag-maturity
//
// Stamps a `maturity: "EXPLORATORY"` field on tool output objects.
// No-op for primitives, arrays, and null.
//
// Phase C will upgrade this to consult the `artifacts` table and apply
// WORKING / FOUNDATION tiers based on evidence strength. For now every
// tool output starts at EXPLORATORY.

import type { PostToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";

/**
 * Stamp maturity on an output value.
 * Returns the (possibly mutated) value.
 */
export function stampMaturity(output: unknown): unknown {
  if (
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    const obj = output as Record<string, unknown>;
    if (!("maturity" in obj)) {
      obj["maturity"] = "EXPLORATORY";
    }
    return obj;
  }
  return output;
}

/**
 * post_tool handler: stamps maturity on payload.output in-place.
 */
export async function tagMaturityHook(payload: PostToolPayload): Promise<void> {
  (payload as { output: unknown }).output = stampMaturity(payload.output);
}

/**
 * Register the tag-maturity hook into a Lifecycle instance.
 */
export function registerTagMaturityHook(lifecycle: Lifecycle): void {
  lifecycle.on("post_tool", "tag-maturity", tagMaturityHook);
}
