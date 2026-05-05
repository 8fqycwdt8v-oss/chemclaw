// ---------------------------------------------------------------------------
// One-way hash for user identifiers in logs.
//
// Why: `userEntraId` looks like an email or a GUID — both are PII. Raw values
// must never reach Loki / Grafana / log archives. The hash is salted with
// `LOG_USER_SALT` (required in production; defaults to a fixed dev salt that
// is intentionally NOT secret — local dev correlations work, prod rotations
// are operator-controlled). The 16-char prefix is enough for cross-service
// correlation without giving an attacker a useful brute-force surface
// (sha256 + 64-bit prefix + per-deploy salt = ~2^64 work to recover).
//
// The same algorithm is mirrored in
// `services/mcp_tools/common/user_hash.py`. The salt env var name is shared
// so an operator only sets it once per cluster.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

const DEFAULT_DEV_SALT = "chemclaw-dev-salt-not-secret";

let _salt: string | null = null;

/**
 * Resolve the salt with fail-closed-by-default semantics. The contract
 * is symmetrical with the Python side and with `MCP_AUTH_DEV_MODE`:
 *
 *   - LOG_USER_SALT set     → use it.
 *   - LOG_USER_SALT unset, CHEMCLAW_DEV_MODE=true → use the public dev
 *     salt (correlations work in local dev; not safe for prod).
 *   - LOG_USER_SALT unset, no dev marker          → throw.
 *
 * Earlier versions gated on `NODE_ENV !== "production"`, but nothing in
 * this codebase sets NODE_ENV, so the throw never fired in any
 * deployment — defeating the whole purpose. Inverting the default
 * (production-by-default) closes that gap. Operators running locally
 * already set CHEMCLAW_DEV_MODE=true via .env.example.
 */
function salt(): string {
  if (_salt !== null) return _salt;
  const fromEnv = process.env.LOG_USER_SALT?.trim();
  if (fromEnv && fromEnv.length > 0) {
    _salt = fromEnv;
    return _salt;
  }
  const isDev = process.env.CHEMCLAW_DEV_MODE === "true";
  if (!isDev) {
    throw new Error(
      "LOG_USER_SALT is required when CHEMCLAW_DEV_MODE != true. " +
        "The default salt is public — without a real salt the 16-hex-char " +
        "hash trivially de-anonymises users via rainbow-table lookup against " +
        "any email or entra-id list.",
    );
  }
  _salt = DEFAULT_DEV_SALT;
  return _salt;
}

/**
 * Hash a user identifier for safe logging. Returns the empty string for
 * empty / undefined input so log call sites can pass user fields directly
 * without null-checks. The hash is stable for the process lifetime.
 */
export function hashUser(userEntraId: string | undefined | null): string {
  if (!userEntraId) return "";
  return createHash("sha256")
    .update(salt())
    .update(":")
    .update(userEntraId)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Boot-time assertion that the user-hash salt is configured.
 *
 * Why this exists: the lazy `salt()` resolver throws on first
 * `hashUser()` call, which means a misconfigured production deploy
 * boots successfully and only fails when an HTTP request first tries
 * to log a user identifier. By that time alerting is gated on
 * fail-only-on-traffic, and dashboards may show "service healthy".
 *
 * Calling this from `loadConfig()` / startup makes a misconfigured
 * `LOG_USER_SALT` a hard boot failure (before app.listen), the same
 * way the Zod schema makes a missing required env var a hard failure.
 *
 * Idempotent: subsequent calls are no-ops once the salt is resolved.
 */
export function assertLogUserSaltConfigured(): void {
  // Triggers the same fail-closed check `hashUser` does, but at a
  // controlled call site so the error stack points at the
  // bootstrap path instead of an unrelated route handler.
  salt();
}

/** Test-only — drop the cached salt so a subsequent hash picks up env changes. */
export function __resetUserHashForTests(): void {
  _salt = null;
}
