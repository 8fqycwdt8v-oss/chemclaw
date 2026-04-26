// post_turn hook: redact-secrets
//
// Defense-in-depth scrub of the assistant's outbound text. The PRIMARY
// egress redactor is the LiteLLM callback at services/litellm_redactor/callback.py
// which scrubs prompts going TO the model. This hook scrubs text going OUT —
// the model's final response and (for streaming) each text_delta as it flows.
//
// Patterns are length-bounded to prevent catastrophic backtracking:
//   1. Reaction SMILES  (\S{1,400}>\S{0,400}>\S{1,400})
//   2. SMILES tokens    (length-bounded char class with bond grammar check)
//   3. Email addresses  (each segment length-capped)
//   4. NCE project IDs  (NCE-\d{1,6})
//   5. Compound codes   (CMP-\d{4,8})
//
// API surface:
//   - registerRedactSecretsHook(lc) wires the post_turn handler.
//   - redactString(text, replacements) is exported so the SSE streamer can
//     redact each text_delta in flight; the post_turn hook then provides a
//     final pass on the buffered finalText to catch any cross-chunk patterns.

import type { PostTurnPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";

// ---------------------------------------------------------------------------
// Compiled patterns (length-bounded — no unbounded quantifiers).
// ---------------------------------------------------------------------------

const RXN_SMILES = /\S{1,400}>\S{0,400}>\S{1,400}/g;

const SMILES_TOKEN = /(?<![A-Za-z0-9])[A-Za-z0-9@+\-\[\]\(\)=#/\\\.]{6,200}(?![A-Za-z0-9])/g;

const EMAIL = /[a-zA-Z0-9_.+\-]{1,64}@[a-zA-Z0-9\-]{1,253}\.[a-zA-Z0-9\-.]{2,63}/g;

const NCE_PROJECT = /\bNCE-\d{1,6}\b/gi;

const COMPOUND_CODE = /\bCMP-\d{4,8}\b/gi;

function looksLikeSmiles(token: string): boolean {
  const hasBond = /[=#()/\\]/.test(token);
  const hasLetter = /[A-Za-z]/.test(token);
  return hasBond && hasLetter && token.length >= 6;
}

export interface RedactReplacement {
  pattern: string;
  original: string;
}

/**
 * Redact sensitive substrings in a single string value.
 * Returns the redacted string and appends each replacement to `replacements`.
 *
 * Exported because the SSE streamer in routes/chat.ts redacts each text_delta
 * chunk in flight, and the post_turn hook below uses the same machinery on
 * the buffered finalText.
 */
export function redactString(
  value: string,
  replacements: RedactReplacement[],
): string {
  let result = value;

  result = result.replace(RXN_SMILES, (match) => {
    if (match.split(">").length - 1 >= 2) {
      replacements.push({ pattern: "RXN_SMILES", original: match });
      return "[REDACTED]";
    }
    return match;
  });

  result = result.replace(SMILES_TOKEN, (match) => {
    if (looksLikeSmiles(match)) {
      replacements.push({ pattern: "SMILES", original: match });
      return "[REDACTED]";
    }
    return match;
  });

  result = result.replace(EMAIL, (match) => {
    replacements.push({ pattern: "EMAIL", original: match });
    return "[REDACTED]";
  });

  result = result.replace(NCE_PROJECT, (match) => {
    replacements.push({ pattern: "NCE", original: match });
    return "[REDACTED]";
  });

  result = result.replace(COMPOUND_CODE, (match) => {
    replacements.push({ pattern: "CMP", original: match });
    return "[REDACTED]";
  });

  return result;
}

/**
 * post_turn handler: scrubs `payload.finalText` in place. Any replacements
 * are appended to a per-turn scratchpad log keyed `redact_log` for observability.
 *
 * This runs even on error paths because the chat route dispatches `post_turn`
 * from a `finally` block (see routes/chat.ts).
 */
export async function redactSecretsHook(payload: PostTurnPayload): Promise<void> {
  const replacements: RedactReplacement[] = [];

  const original = payload.finalText ?? "";
  const redacted = redactString(original, replacements);

  if (redacted !== original) {
    payload.finalText = redacted;
  }

  if (replacements.length > 0) {
    const existing =
      (payload.ctx.scratchpad.get("redact_log") as Array<{
        scope: string;
        replacements: RedactReplacement[];
        timestamp: string;
      }>) ?? [];
    payload.ctx.scratchpad.set("redact_log", [
      ...existing,
      {
        scope: "post_turn",
        replacements,
        timestamp: new Date().toISOString(),
      },
    ]);
  }
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
