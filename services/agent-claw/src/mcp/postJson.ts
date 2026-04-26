// postJson / getJson — typed HTTP helpers for MCP tool services.
//
// Defences:
//   - explicit AbortController timeout (no hanging calls)
//   - response validated via Zod before returning to caller
//   - no retries (retries belong in the caller's agent loop)
//   - UpstreamError carries service name + status for diagnostics
//   - When MCP_AUTH_SIGNING_KEY is set, attaches a per-call HS256 JWT
//     scoped to the named service. ADR 006 Layer 2.

import { z } from "zod";
import { getMcpToken } from "../security/mcp-token-cache.js";
import { getRequestContext } from "../core/request-context.js";

export class UpstreamError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`${service} returned ${status}: ${detail}`);
    this.name = "UpstreamError";
  }
}

/**
 * Build the auth header for an outbound MCP call.
 *
 * The userEntraId is read from:
 *   1. Explicit `opts.userEntraId` (escape hatch for tests / one-offs)
 *   2. AsyncLocalStorage request context (the normal production path —
 *      the chat / sessions routes wrap harness execution in
 *      runWithRequestContext, and that context is automatically visible
 *      to every awaited call below)
 *   3. Otherwise undefined → no header → MCP service in dev mode accepts
 *      with a warning, in prod mode rejects with 401
 *
 * When MCP_AUTH_SIGNING_KEY is unset, getMcpToken returns undefined and
 * we send no Authorization header at all — dev mode keeps working.
 */
function authHeaders(service: string, explicitUserEntraId?: string): Record<string, string> {
  const userEntraId =
    explicitUserEntraId ?? getRequestContext()?.userEntraId;
  if (!userEntraId) return {};
  const token = getMcpToken({ userEntraId, service });
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface RequestOptions {
  /** Override the user identity for this single call. Normally not needed
   * — postJson reads from the AsyncLocalStorage request context that the
   * route handler set at turn start. Use this to send a call as a
   * different user (admin → end-user impersonation, etc.). */
  userEntraId?: string;
}

export async function postJson<TReq, TRes>(
  url: string,
  body: TReq,
  respSchema: z.ZodType<TRes>,
  timeoutMs: number,
  service: string,
  opts: RequestOptions = {},
): Promise<TRes> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(service, opts.userEntraId),
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      throw new UpstreamError(service, r.status, text.slice(0, 200));
    }
    const parsed = respSchema.safeParse(text.length ? JSON.parse(text) : null);
    if (!parsed.success) {
      throw new UpstreamError(
        service,
        502,
        `invalid response shape: ${parsed.error.issues[0]?.message ?? "?"}`,
      );
    }
    return parsed.data;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Typed HTTP GET helper for MCP tool services.
 *
 * Same defenses as postJson: bounded timeout, response validated via Zod
 * before returning. Use this for fetch-style endpoints where the request
 * has no body (e.g. mcp-eln-benchling GET /experiments/{id}).
 */
export async function getJson<TRes>(
  url: string,
  respSchema: z.ZodType<TRes>,
  timeoutMs: number,
  service: string,
  opts: RequestOptions = {},
): Promise<TRes> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        ...authHeaders(service, opts.userEntraId),
      },
      signal: ctl.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      throw new UpstreamError(service, r.status, text.slice(0, 200));
    }
    const parsed = respSchema.safeParse(text.length ? JSON.parse(text) : null);
    if (!parsed.success) {
      throw new UpstreamError(
        service,
        502,
        `invalid response shape: ${parsed.error.issues[0]?.message ?? "?"}`,
      );
    }
    return parsed.data;
  } finally {
    clearTimeout(t);
  }
}
