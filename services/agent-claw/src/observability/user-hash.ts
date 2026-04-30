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

function salt(): string {
  if (_salt !== null) return _salt;
  const fromEnv = process.env.LOG_USER_SALT?.trim();
  _salt = fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_DEV_SALT;
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

/** Test-only — drop the cached salt so a subsequent hash picks up env changes. */
export function __resetUserHashForTests(): void {
  _salt = null;
}
