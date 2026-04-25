// pre_tool hook: redact-secrets
//
// Scans tool input strings for sensitive patterns (ported subset from
// services/litellm_redactor/redaction.py) and replaces matches with
// [REDACTED] before the tool executes.
//
// Patterns kept to the 5 most important, all length-bounded to prevent
// catastrophic backtracking:
//   1. Reaction SMILES  (\S{1,400}>\S{0,400}>\S{1,400})
//   2. SMILES tokens    (length-bounded char class with bond grammar check)
//   3. Email addresses  (each segment length-capped)
//   4. NCE project IDs  (NCE-\d{1,6})
//   5. Compound codes   (CMP-\d{4,8})

import type { PreToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";

// ---------------------------------------------------------------------------
// Compiled patterns (length-bounded — no unbounded quantifiers).
// ---------------------------------------------------------------------------

// Reaction SMILES: must have two '>' separators.
const RXN_SMILES = /\S{1,400}>\S{0,400}>\S{1,400}/g;

// SMILES-like tokens: bounded char class, must contain bond/atom grammar.
// This is a conservative heuristic; over-redaction is preferred.
const SMILES_TOKEN = /(?<![A-Za-z0-9])[A-Za-z0-9@+\-\[\]\(\)=#/\\\.]{6,200}(?![A-Za-z0-9])/g;

// Email: each component length-capped.
const EMAIL = /[a-zA-Z0-9_.+\-]{1,64}@[a-zA-Z0-9\-]{1,253}\.[a-zA-Z0-9\-.]{2,63}/g;

// NCE project identifier.
const NCE_PROJECT = /\bNCE-\d{1,6}\b/gi;

// Internal compound code.
const COMPOUND_CODE = /\bCMP-\d{4,8}\b/gi;

// SMILES heuristic: must contain at least one bond/ring character.
function looksLikeSmiles(token: string): boolean {
  const hasBond = /[=#()/\\]/.test(token);
  const hasLetter = /[A-Za-z]/.test(token);
  return hasBond && hasLetter && token.length >= 6;
}

/**
 * Redact sensitive substrings in a single string value.
 * Returns the redacted string and logs replacements into the scratchpad array.
 */
export function redactString(
  value: string,
  replacements: Array<{ pattern: string; original: string }>,
): string {
  let result = value;

  // 1. Reaction SMILES (before generic SMILES token).
  result = result.replace(RXN_SMILES, (match) => {
    if (match.split(">").length - 1 >= 2) {
      replacements.push({ pattern: "RXN_SMILES", original: match });
      return "[REDACTED]";
    }
    return match;
  });

  // 2. Generic SMILES tokens.
  result = result.replace(SMILES_TOKEN, (match) => {
    if (looksLikeSmiles(match)) {
      replacements.push({ pattern: "SMILES", original: match });
      return "[REDACTED]";
    }
    return match;
  });

  // 3. Email.
  result = result.replace(EMAIL, (match) => {
    replacements.push({ pattern: "EMAIL", original: match });
    return "[REDACTED]";
  });

  // 4. NCE project ID.
  result = result.replace(NCE_PROJECT, (match) => {
    replacements.push({ pattern: "NCE", original: match });
    return "[REDACTED]";
  });

  // 5. Compound code.
  result = result.replace(COMPOUND_CODE, (match) => {
    replacements.push({ pattern: "CMP", original: match });
    return "[REDACTED]";
  });

  return result;
}

/**
 * Recursively redact string values in an arbitrary payload.
 * Mutates in place and returns the redaction log.
 */
function redactValue(
  value: unknown,
  replacements: Array<{ pattern: string; original: string }>,
): unknown {
  if (typeof value === "string") {
    return redactString(value, replacements);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = redactValue(value[i], replacements);
    }
    return value;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      obj[key] = redactValue(obj[key], replacements);
    }
    return obj;
  }
  return value;
}

/**
 * pre_tool handler: mutates payload.input in-place, appending redaction
 * metadata into the per-turn scratchpad.
 */
export async function redactSecretsHook(payload: PreToolPayload): Promise<void> {
  const replacements: Array<{ pattern: string; original: string }> = [];

  // Mutate in-place (the payload.input is passed by reference in the harness).
  const redacted = redactValue(payload.input, replacements);
  // Reassign to handle the top-level string case.
  (payload as { input: unknown }).input = redacted;

  if (replacements.length > 0) {
    // Append structured log to scratchpad for observability.
    const existing = (payload.ctx.scratchpad.get("redact_log") as typeof replacements) ?? [];
    payload.ctx.scratchpad.set("redact_log", [
      ...existing,
      {
        toolId: payload.toolId,
        replacements,
        timestamp: new Date().toISOString(),
      },
    ]);
  }
}

/**
 * Register the redact-secrets hook into a Lifecycle instance.
 */
export function registerRedactSecretsHook(lifecycle: Lifecycle): void {
  lifecycle.on("pre_tool", "redact-secrets", redactSecretsHook);
}
