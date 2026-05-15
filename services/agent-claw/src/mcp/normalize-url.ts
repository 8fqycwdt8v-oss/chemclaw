// Tranche 5 L6: extracted helper for the trailing-slash normalisation
// pattern that ~57 builtins used inline. Centralising it lets us:
//   1. Apply consistent treatment to MCP_*_URL config strings (most are
//      already trailing-slash-clean, but defensive normalisation guards
//      against operator typos in .env / Helm values).
//   2. Add future URL-policy logic (e.g. enforce HTTPS in production,
//      reject non-loopback ports in dev) in one place.
//   3. Make the per-builtin call site one line shorter and visually
//      uniform: `const base = normalizeUrl(url);`.
//
// The semantic is `String.prototype.replace(/\/$/, "")` — strips a single
// trailing forward slash if present, returns the original otherwise.
// Empty input returns empty string. Whitespace is NOT trimmed (URLs with
// surrounding whitespace are operator config errors, not something we
// should silently paper over).

/**
 * Strip a single trailing forward slash from `url` if present.
 *
 * Idempotent — `normalizeUrl(normalizeUrl(x)) === normalizeUrl(x)`.
 *
 * Examples:
 *   normalizeUrl("http://x.test/")     // "http://x.test"
 *   normalizeUrl("http://x.test")      // "http://x.test"
 *   normalizeUrl("http://x.test/path") // "http://x.test/path"  (only trailing)
 *   normalizeUrl("")                   // ""
 */
export function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}
