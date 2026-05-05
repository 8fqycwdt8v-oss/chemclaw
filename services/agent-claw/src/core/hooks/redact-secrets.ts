// post_turn hook: redact-secrets
//
// Defense-in-depth scrub of the assistant's outbound text. The PRIMARY
// egress redactor is the LiteLLM callback at services/litellm_redactor/callback.py
// which scrubs prompts going TO the model. This hook scrubs text going OUT —
// the model's final response and (for streaming) each text_delta as it flows.
//
// The actual regex machinery lives in observability/redact-string.ts as a
// leaf utility (no internal deps) so the Pino logger can import it without
// pulling in core/* (which would create a circular-import risk against the
// logger itself). This file owns the post_turn lifecycle binding only.
//
// Patterns are length-bounded to prevent catastrophic backtracking:
//   1. Reaction SMILES  (\S{1,400}>\S{0,400}>\S{1,400})
//   2. SMILES tokens    (length-bounded char class with bond grammar check)
//   3. Email addresses  (each segment length-capped)
//   4. NCE project IDs  (NCE-\d{1,6})
//   5. Compound codes   (CMP-\d{4,8})

import type { PostTurnPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import {
  redactString,
  type RedactReplacement,
  MAX_REDACTION_INPUT_LEN,
} from "../../observability/redact-string.js";

// Re-export so existing callers that import { redactString } from this
// module keep working. The single source of truth is observability/redact-string.ts.
export { redactString, MAX_REDACTION_INPUT_LEN };
export type { RedactReplacement };

/**
 * post_turn handler: scrubs `payload.finalText` in place. Any replacements
 * are appended to a per-turn scratchpad log keyed `redact_log` for observability.
 *
 * This runs even on error paths because `runHarness` dispatches `post_turn`
 * from its own `finally` block (see `core/harness.ts:195-204`). Routes do
 * not redispatch — the v1.2 rebuild made `runHarness` the single source of
 * truth for the dispatch.
 */
export async function redactSecretsHook(
  payload: PostTurnPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  const replacements: RedactReplacement[] = [];

  const original = payload.finalText;
  const redacted = redactString(original, replacements);

  if (redacted !== original) {
    payload.finalText = redacted;
  }

  if (replacements.length > 0) {
    const existing =
      (payload.ctx.scratchpad.get("redact_log") as
        | Array<{
            scope: string;
            replacements: RedactReplacement[];
            timestamp: string;
          }>
        | undefined) ?? [];
    payload.ctx.scratchpad.set("redact_log", [
      ...existing,
      {
        scope: "post_turn",
        replacements,
        timestamp: new Date().toISOString(),
      },
    ]);
  }
  return {};
}

/**
 * Register the redact-secrets hook into a Lifecycle instance.
 *
 * Hook point: post_turn (defense-in-depth on outbound assistant text).
 * The historical pre_tool registration was a regression — it mangled tool
 * inputs (e.g. SMILES → [REDACTED] before chemistry tools saw them).
 */
export function registerRedactSecretsHook(lifecycle: Lifecycle): void {
  lifecycle.on("post_turn", "redact-secrets", redactSecretsHook);
}
