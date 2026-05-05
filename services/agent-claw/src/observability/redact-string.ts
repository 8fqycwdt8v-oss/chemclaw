// Leaf redaction utility for observability + post-turn output scrub.
//
// Why this lives in observability/, not core/hooks/:
//   The Pino logger needs to scrub free-form error messages and stack
//   traces (Postgres / MCP errors regularly carry SMILES + compound codes
//   in driver-provided "Failing row contains (...)" strings). Importing
//   from core/hooks/* into a leaf module like observability/logger.ts
//   creates a circular dep risk because core/* eventually loads the
//   logger. So the actual regex machinery lives here and the
//   post_turn hook in core/hooks/redact-secrets.ts re-exports / re-uses
//   the same primitive.
//
// All patterns are length-bounded (no unbounded `.+` / `.*`) so a
// maliciously crafted log payload cannot cause catastrophic backtracking
// inside the logger's serialiser path.

// Defense against pathological input: real prompts are <100KB. Anything past
// this cap is returned unmodified, bounding worst-case CPU. Even bounded
// quantifiers do O(n*k) work — n in megabytes is enough to be a soft DoS.
export const MAX_REDACTION_INPUT_LEN = 5 * 1024 * 1024;

// Always pre-gated on a cheap >=2 '>' count: prose without reaction arrows
// skips the bounded-quantifier scan entirely.
const RXN_SMILES = /\S{1,400}>\S{0,400}>\S{1,400}/g;

const SMILES_TOKEN = /(?<![A-Za-z0-9])[A-Za-z0-9@+\-[\]()=#/\\.]{6,200}(?![A-Za-z0-9])/g;

const EMAIL = /[a-zA-Z0-9_.+-]{1,64}@[a-zA-Z0-9-]{1,253}\.[a-zA-Z0-9.-]{2,63}/g;

const NCE_PROJECT = /\bNCE-\d{1,6}\b/gi;

const COMPOUND_CODE = /\bCMP-\d{4,8}\b/gi;

function looksLikeSmiles(token: string): boolean {
  // Tightening (audit cycle 4): a single '=' or '/' character is not enough
  // to call a token a SMILES — that false-positives on URL query strings
  // ("opt=value", "key=12") and CLI flags. Real SMILES carry one of:
  //   - a bracketed atom ([Na+], [C@H], [O-]),
  //   - a ring-closure digit immediately after a SMILES atom letter
  //     (c1, C2 — restricted to organic subset so "x1" in prose doesn't fire),
  //   - a multi-bond followed by a SMILES atom letter
  //     (=C, #N, =O, /C, \C — same atom-letter restriction).
  // We additionally require >=2 alphabetic characters so things like
  // "(=12)" or "[1-2]" (purely punctuation+digits) don't match.
  // SMILES atom letters: organic subset + aromatic lowercase
  // (C, N, O, S, P, F, B, I, H, c, n, o, s, p, b). Two-letter Cl/Br
  // start with C/B which are in the subset.
  if (token.length < 6) return false;
  const letters = token.match(/[A-Za-z]/g)?.length ?? 0;
  if (letters < 2) return false;
  const hasBracketedAtom = /\[[A-Za-z]/.test(token);
  const hasRingClosure = /[CNOSPFBIHcnospb]\d/.test(token);
  const hasMultiBond = /[=#/\\][CNOSPFBIHcnospb]/.test(token);
  return hasBracketedAtom || hasRingClosure || hasMultiBond;
}

export interface RedactReplacement {
  pattern: string;
  original: string;
}

/**
 * Redact sensitive substrings in a single string value.
 * Returns the redacted string and appends each replacement to `replacements`.
 *
 * This is the single TS-side implementation of the regex pipeline mirrored
 * by services/litellm_redactor/redaction.py. Callers:
 *   - services/agent-claw/src/core/hooks/redact-secrets.ts (post_turn hook)
 *   - services/agent-claw/src/core/session-state.ts (awaiting-question save)
 *   - services/agent-claw/src/observability/logger.ts (Pino err serializer)
 */
export function redactString(
  value: string,
  replacements: RedactReplacement[],
): string {
  // Bound worst-case CPU: refuse pathologically large input rather than
  // burn seconds in the regex engine.
  if (!value || value.length > MAX_REDACTION_INPUT_LEN) {
    return value;
  }

  let result = value;

  // Pre-gate: RXN_SMILES requires two '>' chars; short-circuit with two
  // O(1)-per-char indexOf calls before invoking the bounded-quantifier scan.
  const firstArrow = value.indexOf(">");
  const hasTwoArrows = firstArrow !== -1 && value.includes(">", firstArrow + 1);
  if (hasTwoArrows) {
    result = result.replace(RXN_SMILES, (match) => {
      if (match.split(">").length - 1 >= 2) {
        replacements.push({ pattern: "RXN_SMILES", original: match });
        return "[REDACTED]";
      }
      return match;
    });
  }

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
 * Convenience wrapper that drops the replacements array; used by leaf
 * callers (logger serializers) that just want a scrubbed string and
 * don't need to know what was replaced.
 */
export function scrub(value: string): string {
  const replacements: RedactReplacement[] = [];
  return redactString(value, replacements);
}
