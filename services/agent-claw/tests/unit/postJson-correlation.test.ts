// Verifies postJson + getJson forward x-request-id / x-session-id from
// the active RequestContext. Without this guarantee, the Python-side
// `add_request_id` middleware generates a fresh UUID for every
// outbound MCP call and the cross-process correlation that the Pino
// mixin promises silently breaks at the boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runWithRequestContext } from "../../src/core/request-context.js";
import { postJson, getJson } from "../../src/mcp/postJson.js";

describe("MCP correlation header propagation", () => {
  const realFetch = globalThis.fetch;
  let capturedHeaders: Headers | null = null;

  beforeEach(() => {
    capturedHeaders = null;
    const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = vi.fn(fakeFetch);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("postJson forwards request_id + session_id from RequestContext", async () => {
    await runWithRequestContext(
      {
        userEntraId: "alice@example.com",
        sessionId: "sess-abc",
        requestId: "req-xyz",
      },
      async () => {
        await postJson("http://x/y", {}, z.object({ ok: z.boolean() }), 5_000, "test-svc");
      },
    );
    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders?.get("x-request-id")).toBe("req-xyz");
    expect(capturedHeaders?.get("x-session-id")).toBe("sess-abc");
  });

  it("getJson forwards correlation headers", async () => {
    await runWithRequestContext(
      { userEntraId: "u", requestId: "req-aaa" },
      async () => {
        await getJson("http://x/y", z.object({ ok: z.boolean() }), 5_000, "test-svc");
      },
    );
    expect(capturedHeaders?.get("x-request-id")).toBe("req-aaa");
    // session_id absent on context → no header.
    expect(capturedHeaders?.get("x-session-id")).toBeNull();
  });

  it("omits headers when no RequestContext is active", async () => {
    await postJson("http://x/y", {}, z.object({ ok: z.boolean() }), 5_000, "test-svc");
    expect(capturedHeaders?.get("x-request-id")).toBeNull();
    expect(capturedHeaders?.get("x-session-id")).toBeNull();
  });

  it("omits empty / undefined fields on context", async () => {
    await runWithRequestContext(
      { userEntraId: "u", requestId: "" /* empty → omit */ },
      async () => {
        await postJson("http://x/y", {}, z.object({ ok: z.boolean() }), 5_000, "test-svc");
      },
    );
    expect(capturedHeaders?.get("x-request-id")).toBeNull();
  });
});
