// Test helper: construct a ToolContext with seenFactIds wired.
//
// Usage:
//   const ctx = makeCtx();                       // empty seenFactIds
//   const ctx = makeCtx("scientist@pharma.com"); // custom user
//   const ctx = makeCtx("user", ["uuid1"]);      // pre-seeded facts

import type { ToolContext } from "../../src/core/types.js";

export function makeCtx(
  userEntraId = "test@example.com",
  preSeededFactIds: string[] = [],
): ToolContext {
  const seenFactIds = new Set<string>(preSeededFactIds);
  const scratchpad = new Map<string, unknown>([
    ["seenFactIds", seenFactIds],
  ]);
  return { userEntraId, scratchpad, seenFactIds };
}
