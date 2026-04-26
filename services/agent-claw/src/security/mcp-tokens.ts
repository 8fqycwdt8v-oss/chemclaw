// MCP service Bearer-token signing (ADR 006 partial — agent side).
//
// Mints HS256 JWTs that MCP services verify via services/mcp_tools/common/auth.py.
// The two implementations MUST stay in sync on payload shape and signing-key
// retrieval. See docs/adr/006-sandbox-isolation.md for the design.
//
// Key management:
//   - MCP_AUTH_SIGNING_KEY environment variable.
//   - Production deploys load this from a Kubernetes secret shared between
//     agent and MCP services.
//   - Dev mode: when MCP_AUTH_REQUIRED is unset / "false", services accept
//     missing tokens with a warning, so existing tests + local-dev still work.
//
// The JWT is intentionally short-lived (5-minute default TTL). When minting
// for an E2B sandbox, scope tokens to the specific MCP services the sandbox
// will call so a stolen token can't escalate access.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface McpTokenClaims {
  /** Subject — usually the sandbox_id or "agent" for direct calls. */
  sub: string;
  /** User Entra-ID — flows through to RLS context inside MCP services. */
  user: string;
  /** List of allowed scopes (e.g. "mcp_kg:read", "mcp_doc_fetcher:fetch"). */
  scopes: string[];
  /** Unix timestamp (seconds) — token expires at this time. */
  exp: number;
  /** Unix timestamp (seconds) — token issued at. */
  iat: number;
}

export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

const TEXT_ENCODER = new TextEncoder();

function b64UrlEncode(data: Uint8Array): string {
  // Node's Buffer.toString('base64url') is widely available since Node 18.
  return Buffer.from(data).toString("base64url");
}

function b64UrlDecode(s: string): Uint8Array {
  return Buffer.from(s, "base64url");
}

/**
 * Mint a fresh JWT for a sandbox or sub-agent → MCP-service call.
 *
 * @param opts.sandboxId   E2B sandbox id, or "agent" for direct calls.
 * @param opts.userEntraId Entra-ID of the calling user (forwarded for RLS).
 * @param opts.scopes      Permitted scopes (e.g. ["mcp_kg:read"]).
 * @param opts.ttlSeconds  TTL (default 300s = 5 min).
 * @param opts.signingKey  Override env-var signing key (for tests).
 * @param opts.now         Override clock (for tests).
 */
export function signMcpToken(opts: {
  sandboxId: string;
  userEntraId: string;
  scopes: string[];
  ttlSeconds?: number;
  signingKey?: string;
  now?: number;
}): string {
  const key = opts.signingKey ?? process.env["MCP_AUTH_SIGNING_KEY"] ?? "";
  if (!key) {
    throw new McpAuthError(
      "MCP_AUTH_SIGNING_KEY is empty; refusing to mint an unsigned token",
    );
  }
  const ttlSeconds = opts.ttlSeconds ?? 300;
  const issuedAt = opts.now ?? Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: McpTokenClaims = {
    sub: opts.sandboxId,
    user: opts.userEntraId,
    scopes: opts.scopes,
    exp: issuedAt + ttlSeconds,
    iat: issuedAt,
  };
  const h = b64UrlEncode(TEXT_ENCODER.encode(JSON.stringify(header)));
  const p = b64UrlEncode(TEXT_ENCODER.encode(JSON.stringify(payload)));
  const signingInput = `${h}.${p}`;
  const sig = createHmac("sha256", key).update(signingInput, "utf8").digest();
  return `${signingInput}.${b64UrlEncode(sig)}`;
}

/**
 * Verify a JWT and return its claims.
 *
 * Constant-time signature comparison; throws on any malformation, bad signature,
 * expired token, or missing field.
 */
export function verifyMcpToken(
  token: string,
  opts: { signingKey?: string; now?: number } = {},
): McpTokenClaims {
  const key = opts.signingKey ?? process.env["MCP_AUTH_SIGNING_KEY"] ?? "";
  if (!key) {
    throw new McpAuthError("MCP_AUTH_SIGNING_KEY is empty; cannot verify token");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new McpAuthError("malformed token: not three dot-separated parts");
  }
  const [h, p, sig] = parts as [string, string, string];

  const signingInput = `${h}.${p}`;
  const expectedSig = createHmac("sha256", key).update(signingInput, "utf8").digest();
  let actualSig: Buffer;
  try {
    actualSig = Buffer.from(b64UrlDecode(sig));
  } catch (err) {
    throw new McpAuthError(`malformed signature: ${(err as Error).message}`);
  }
  if (
    actualSig.length !== expectedSig.length ||
    !timingSafeEqual(expectedSig, actualSig)
  ) {
    throw new McpAuthError("bad signature");
  }

  let header: { alg?: string };
  let payload: Partial<McpTokenClaims>;
  try {
    header = JSON.parse(Buffer.from(b64UrlDecode(h)).toString("utf-8"));
    payload = JSON.parse(Buffer.from(b64UrlDecode(p)).toString("utf-8"));
  } catch (err) {
    throw new McpAuthError(`malformed JSON: ${(err as Error).message}`);
  }
  if (header.alg !== "HS256") {
    throw new McpAuthError(`unexpected alg: ${header.alg}`);
  }
  if (typeof payload.exp !== "number") {
    throw new McpAuthError("missing or non-integer exp");
  }
  const current = opts.now ?? Math.floor(Date.now() / 1000);
  if (payload.exp < current) {
    throw new McpAuthError(`token expired at ${payload.exp} (now=${current})`);
  }
  if (typeof payload.sub !== "string" || typeof payload.user !== "string") {
    throw new McpAuthError("missing sub or user");
  }
  if (
    !Array.isArray(payload.scopes) ||
    !payload.scopes.every((s) => typeof s === "string")
  ) {
    throw new McpAuthError("scopes must be a string[]");
  }
  return {
    sub: payload.sub,
    user: payload.user,
    scopes: payload.scopes,
    exp: payload.exp,
    iat: typeof payload.iat === "number" ? payload.iat : 0,
  };
}
