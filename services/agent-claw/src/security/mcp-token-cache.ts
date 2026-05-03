// Per-process MCP token cache (ADR 006 Layer 2 wire-up).
//
// The agent → MCP-service path mints a fresh JWT for each (userEntraId,
// service-scope) pair, but tokens have a 5-minute TTL — caching them
// for ~4 minutes (buffer = 60s) keeps mint cost low while leaving plenty
// of room for clock skew. Cache is in-process; restarting the agent
// invalidates it (correct: tokens are agent-bound).
//
// Design decisions:
//   - When MCP_AUTH_SIGNING_KEY is unset, getMcpToken returns undefined.
//     Callers (postJson/getJson) skip the Authorization header entirely.
//     MCP services in dev mode (MCP_AUTH_REQUIRED=false) accept missing
//     tokens with a warning. Net: dev works without setup.
//   - Scopes are coarse-by-service (mcp_kg:rw, mcp_doc_fetcher:fetch, etc.).
//     Fine-grained per-tool scopes (mcp_kg:write_fact) are deferred —
//     hard to maintain as tools change.
//   - The cache key is "<userEntraId>|<service>". A user with concurrent
//     calls to two MCPs gets two cached tokens; that's correct because
//     the token's `scopes` claim differs per service.

import { signMcpToken, McpAuthError } from "./mcp-tokens.js";

/** Coarse per-service scope strings issued to outbound calls.
 *  Mirror of `services/mcp_tools/common/scopes.py` SERVICE_SCOPES.
 *  A pact test asserts equality; keep both maps in sync by hand. */
export const SERVICE_SCOPES: Record<string, string> = {
  "mcp-rdkit": "mcp_rdkit:invoke",
  "mcp-drfp": "mcp_drfp:invoke",
  "mcp-kg": "mcp_kg:rw",
  "mcp-embedder": "mcp_embedder:invoke",
  "mcp-tabicl": "mcp_tabicl:invoke",
  "mcp-doc-fetcher": "mcp_doc_fetcher:fetch",
  "mcp-askcos": "mcp_askcos:invoke",
  "mcp-aizynth": "mcp_aizynth:invoke",
  "mcp-chemprop": "mcp_chemprop:invoke",
  "mcp-yield-baseline": "mcp_yield_baseline:invoke",
  "mcp-plate-designer": "mcp_plate_designer:invoke",
  "mcp-ord-io": "mcp_ord_io:invoke",
  "mcp-xtb": "mcp_xtb:invoke",
  "mcp-crest": "mcp_crest:invoke",
  "mcp-genchem": "mcp_genchem:invoke",
  "mcp-sirius": "mcp_sirius:invoke",
  "mcp-eln-local": "mcp_eln:read",
  "mcp-logs-sciy": "mcp_instrument:read",
  "mcp-synthegy-mech": "mcp_synthegy_mech:invoke",
  "mcp-yield-baseline": "mcp_yield_baseline:invoke",
  "mcp-reaction-optimizer": "mcp_reaction_optimizer:invoke",
  "mcp-plate-designer": "mcp_plate_designer:invoke",
  "mcp-ord-io": "mcp_ord_io:invoke",
};

const DEFAULT_TTL_SECONDS = 300; // 5 min — matches the verifier's expiry check
const REFRESH_BUFFER_SECONDS = 60; // refresh 60s before expiry

interface CachedToken {
  token: string;
  expiresAt: number; // unix seconds
}

const _cache = new Map<string, CachedToken>();

/**
 * Get a JWT for the (userEntraId, service) pair. Returns undefined when
 * MCP_AUTH_SIGNING_KEY is unset — caller skips the Authorization header
 * (compatible with MCP services running in MCP_AUTH_REQUIRED=false mode).
 *
 * Caches tokens for ~4 minutes (TTL minus REFRESH_BUFFER_SECONDS) per cache
 * key so repeated outbound calls don't pay the HMAC cost on every request.
 */
export function getMcpToken(opts: {
  userEntraId: string;
  service: string;
  /** "agent" by default — overridable for sandbox-originated calls (Phase I). */
  sandboxId?: string;
  /** Test-only injection to avoid reading env. */
  signingKey?: string;
  now?: number;
}): string | undefined {
  const key = opts.signingKey ?? process.env.MCP_AUTH_SIGNING_KEY ?? "";
  if (!key) return undefined;

  const cacheKey = `${opts.userEntraId}|${opts.service}|${opts.sandboxId ?? "agent"}`;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt - now > REFRESH_BUFFER_SECONDS) {
    return cached.token;
  }

  // Fail-loud on unknown service: the previous DEFAULT_SCOPE="mcp:invoke"
  // fallback minted a token that no MCP would accept, producing a
  // guaranteed-403 that LOOKS like an auth bug. Throwing here surfaces
  // the typo at mint-time instead.
  const scope = SERVICE_SCOPES[opts.service];
  if (!scope) {
    throw new McpAuthError(
      `unknown MCP service ${JSON.stringify(opts.service)}; ` +
        "add it to SERVICE_SCOPES in mcp-token-cache.ts and the Python mirror " +
        "in services/mcp_tools/common/scopes.py",
    );
  }

  try {
    // audience binds this token to one specific MCP service so it can't
    // be replayed against a peer (blue/green deployment, per-tenant
    // copy). Without this, scope-only enforcement leaves a 5-minute
    // replay window if the token leaks.
    const token = signMcpToken({
      sandboxId: opts.sandboxId ?? "agent",
      userEntraId: opts.userEntraId,
      scopes: [scope],
      audience: opts.service,
      ttlSeconds: DEFAULT_TTL_SECONDS,
      signingKey: key,
      now,
    });
    _cache.set(cacheKey, {
      token,
      expiresAt: now + DEFAULT_TTL_SECONDS,
    });
    return token;
  } catch (err) {
    if (err instanceof McpAuthError) {
      // Surface the underlying problem so dev knows the key is set but
      // can't be used. Do NOT silently fall through to undefined here —
      // that would mask a bona fide config error as "auth disabled".
      throw err;
    }
    throw err;
  }
}

/**
 * Drop the cache. Tests use this between cases; production rarely needs it.
 */
export function clearMcpTokenCache(): void {
  _cache.clear();
}
