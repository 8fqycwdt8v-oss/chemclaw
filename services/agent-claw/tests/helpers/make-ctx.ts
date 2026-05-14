// Test helper: construct a ToolContext with seenFactIds wired.
//
// Usage:
//   const ctx = makeCtx();                                       // empty seenFactIds
//   const ctx = makeCtx("scientist@pharma.com");                 // custom user
//   const ctx = makeCtx("user", ["uuid1"]);                      // pre-seeded facts
//   const ctx = makeCtx("user", [], { orgId: "acme" });          // org-scoped policy tests

import type { ToolContext } from "../../src/core/types.js";

export function makeCtx(
  userEntraId = "test@example.com",
  preSeededFactIds: string[] = [],
  opts: { orgId?: string | null; nceProjectId?: string | null } = {},
): ToolContext {
  const seenFactIds = new Set<string>(preSeededFactIds);
  const scratchpad = new Map<string, unknown>([
    ["seenFactIds", seenFactIds],
  ]);
  return {
    userEntraId,
    orgId: opts.orgId ?? null,
    nceProjectId: opts.nceProjectId ?? null,
    scratchpad,
    seenFactIds,
  };
}
