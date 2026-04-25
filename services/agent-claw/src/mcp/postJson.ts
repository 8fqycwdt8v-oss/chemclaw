// postJson — typed HTTP POST helper for MCP tool services.
// Ported from services/agent/src/mcp-clients.ts.
//
// Defences:
//   - explicit AbortController timeout (no hanging calls)
//   - response validated via Zod before returning to caller
//   - no retries (retries belong in the caller's agent loop)
//   - UpstreamError carries service name + status for diagnostics

import { z } from "zod";

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

export async function postJson<TReq, TRes>(
  url: string,
  body: TReq,
  respSchema: z.ZodType<TRes>,
  timeoutMs: number,
  service: string,
): Promise<TRes> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
