// pre_tool hook: wiki-human-block-guard — ADR 012 Phase 1 (knowledge wiki).
//
// Knowledge-wiki pages may carry human-authored prose wrapped in
//   <!-- human:begin owner=<entra-id> name=<name> --> … <!-- human:end -->
// blocks. Those are sacrosanct: the wiki_pages projector copies them through
// verbatim and they only ever appear because a human edited the page via
// PATCH /api/articles/:id. An agent calling `upsert_article` must never author
// such a marker — doing so would let it forge "human-authored" content (and a
// fake owner). This hook denies an upsert_article whose body contains a
// `<!-- human:begin ... -->` marker.
//
// (Defense in depth: upsert_article's execute also rejects this, and refuses
// to overwrite any page whose has_human_edits flag is set — that check needs
// the DB row, so it lives in the builtin, not here.)
//
// Phase 4A pattern: return a `permissionDecision: "deny"` HookJSONOutput rather
// than throwing — run-one-tool.ts honours the deny by short-circuiting
// tool.execute and surfacing a synthetic rejection the model can react to.

import type { PreToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";

const GUARDED_TOOL_IDS = new Set(["upsert_article"]);
const HUMAN_BLOCK_BEGIN_RE = /<!--\s*human:begin\b[^>]*-->/i;

export async function wikiHumanBlockGuardHook(
  payload: PreToolPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  if (!GUARDED_TOOL_IDS.has(payload.toolId)) return {};

  const input = payload.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const body = (input as Record<string, unknown>).body_md;
  if (typeof body !== "string") return {};

  if (HUMAN_BLOCK_BEGIN_RE.test(body)) {
    return {
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "deny",
        permissionDecisionReason:
          "wiki-human-block-guard: the article body contains a " +
          "`<!-- human:begin ... -->` marker. Those blocks are reserved for " +
          "human edits via PATCH /api/articles/:id; agents must not author " +
          "them. To preserve existing human-authored content, use " +
          "`request_article` to have the wiki_pages projector regenerate the " +
          "page around the human blocks instead of overwriting it.",
      },
    };
  }
  return {};
}

export function registerWikiHumanBlockGuardHook(lifecycle: Lifecycle): void {
  lifecycle.on("pre_tool", "wiki-human-block-guard", wikiHumanBlockGuardHook);
}
