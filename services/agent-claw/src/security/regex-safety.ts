// Server-side regex safety checks shared between admin endpoints that
// accept operator-supplied patterns (`redaction_patterns`,
// `permission_policies.argument_pattern`).
//
// Why this is centralised: the redaction pattern admin route caught
// catastrophic-backtracking attacks via the textbook `(a+)+` / `(a|a)*`
// shape, but the permission-policy admin route only compile-checked its
// `argument_pattern` field. The loader applies that pattern to every
// tool input on every dispatch, so an admin (or compromised admin) can
// install an org-scoped policy with a pathological regex and DoS the
// agent's pre_tool path. Sharing one validator means future admin
// surfaces inherit the same protection by importing this module.
//
// Mirror: `services/litellm_redactor/dynamic_patterns.py:is_pattern_safe`
// implements the same rule for the Python side.

/**
 * Returns a non-null reason string when the pattern contains an
 * unbounded quantifier (`+`, `*`, or `{n,}`) that would let a crafted
 * input drive worst-case backtracking into seconds-of-CPU territory.
 *
 * The rule is "every quantifier must be bounded" — every `+` / `*`
 * becomes `{n,m}` with an explicit upper bound. Escape sequences,
 * character classes, and `?` (0-or-1) are allowed verbatim.
 */
export function findUnboundedQuantifier(raw: string): string | null {
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i];
    if (c === "\\") {
      // Skip the escape and its target — `\+` / `\*` are literals.
      i += 2;
      continue;
    }
    if (c === "[") {
      // Walk the class body; `[+*]` is a literal class.
      i += 1;
      while (i < n && raw[i] !== "]") {
        if (raw[i] === "\\" && i + 1 < n) {
          i += 2;
        } else {
          i += 1;
        }
      }
      i += 1; // past the closing ']'
      continue;
    }
    if (c === "+" || c === "*") {
      return `unbounded quantifier '${c}' at offset ${i} (use bounded {n,m} form)`;
    }
    if (c === "{") {
      const close = raw.indexOf("}", i);
      if (close !== -1) {
        const quant = raw.slice(i + 1, close);
        if (quant.includes(",")) {
          const parts = quant.split(",");
          if (parts.length === 2 && parts[1]?.trim() === "") {
            return `open-ended quantifier '{...,}' at offset ${i} (use bounded {n,m} form)`;
          }
        }
      }
    }
    i += 1;
  }
  return null;
}

/**
 * Length cap + unbounded-quantifier check. Returns `{ ok: true }` for
 * safe patterns, otherwise `{ ok: false, reason: string }`.
 *
 * The default 200-character cap matches the existing
 * `redaction_patterns_no_long_pattern` SQL CHECK; callers that need a
 * different cap can pass `maxLength`.
 */
export function isPatternSafe(
  raw: string,
  maxLength = 200,
): { ok: boolean; reason?: string } {
  if (raw.length > maxLength) {
    return { ok: false, reason: `pattern length > ${maxLength}` };
  }
  const why = findUnboundedQuantifier(raw);
  if (why) return { ok: false, reason: why };
  // Compile-check so a syntactically broken regex is rejected at the
  // admin boundary instead of silently disabling the policy at load.
  try {
    new RegExp(raw);
  } catch (e) {
    return { ok: false, reason: `invalid regex: ${(e as Error).message}` };
  }
  return { ok: true };
}
