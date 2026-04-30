// Vitest tests for the Paperclip-lite client (services/agent-claw side).
// Uses mocked fetch to avoid network calls.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaperclipClient, PaperclipBudgetError } from "../../src/core/paperclip-client.js";

// ---------------------------------------------------------------------------
// Mock fetch factory
// ---------------------------------------------------------------------------

function makeOkFetch(body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  });
}

function make429Fetch(reason: string, retryAfter: number): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 429,
    headers: { get: (k: string) => (k === "Retry-After" ? String(retryAfter) : null) },
    json: async () => ({ reason }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PaperclipClient — disabled (no URL)", () => {
  it("reserve returns a noop handle when PAPERCLIP_URL is unset", async () => {
    const client = new PaperclipClient({ paperclipUrl: undefined });
    const handle = await client.reserve({
      userEntraId: "user-1",
      sessionId: "sess-1",
      estTokens: 1000,
      estUsd: 0.01,
    });
    expect(handle.reservationId).toBe("noop");
    // release should not throw
    await expect(handle.release(900, 0.009)).resolves.toBeUndefined();
  });

  it("enabled is false when URL unset", () => {
    const client = new PaperclipClient({ paperclipUrl: undefined });
    expect(client.enabled).toBe(false);
  });
});

describe("PaperclipClient — enabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enabled is true when URL is set", () => {
    const client = new PaperclipClient({
      paperclipUrl: "http://localhost:3200",
      fetch: makeOkFetch({ reservation_id: "r1" }),
    });
    expect(client.enabled).toBe(true);
  });

  it("reserve POSTs to /reserve and returns reservationId", async () => {
    const mockFetch = makeOkFetch({ reservation_id: "res-abc" });
    const client = new PaperclipClient({
      paperclipUrl: "http://localhost:3200",
      heartbeatIntervalMs: 999_999, // don't fire in tests
      fetch: mockFetch,
    });

    const handle = await client.reserve({
      userEntraId: "user-2",
      sessionId: "sess-2",
      estTokens: 5000,
      estUsd: 0.05,
    });

    expect(handle.reservationId).toBe("res-abc");
    // Verify the fetch was called with the correct path
    expect((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/reserve");
  });

  it("throws PaperclipBudgetError on 429", async () => {
    const mockFetch = make429Fetch("concurrency_limit", 30);
    const client = new PaperclipClient({
      paperclipUrl: "http://localhost:3200",
      fetch: mockFetch,
    });

    await expect(
      client.reserve({
        userEntraId: "user-3",
        sessionId: "sess-3",
        estTokens: 1000,
        estUsd: 0.01,
      }),
    ).rejects.toThrow(PaperclipBudgetError);
  });

  it("PaperclipBudgetError has retryAfterSeconds and reason", async () => {
    const mockFetch = make429Fetch("usd_budget", 3600);
    const client = new PaperclipClient({
      paperclipUrl: "http://localhost:3200",
      fetch: mockFetch,
    });

    let caught: PaperclipBudgetError | undefined;
    try {
      await client.reserve({
        userEntraId: "user-4",
        sessionId: "sess-4",
        estTokens: 1000,
        estUsd: 0.01,
      });
    } catch (e) {
      if (e instanceof PaperclipBudgetError) caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught!.reason).toBe("usd_budget");
    expect(caught!.retryAfterSeconds).toBe(3600);
  });

  it("release POSTs to /release with actual usage", async () => {
    const calls: Array<[string, unknown]> = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: { body?: string }) => {
      calls.push([url, opts.body ? JSON.parse(opts.body) : null]);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () =>
          url.includes("/reserve") ? { reservation_id: "r-rel" } : { status: "released" },
      };
    }) as unknown as typeof fetch;

    const client = new PaperclipClient({
      paperclipUrl: "http://localhost:3200",
      heartbeatIntervalMs: 999_999,
      fetch: mockFetch,
    });

    const handle = await client.reserve({
      userEntraId: "user-5",
      sessionId: "sess-5",
      estTokens: 500,
      estUsd: 0.005,
    });

    await handle.release(480, 0.0048);

    const relCall = calls.find(([url]) => url.includes("/release"));
    expect(relCall).toBeDefined();
    expect((relCall![1] as Record<string, unknown>).reservation_id).toBe("r-rel");
    expect((relCall![1] as Record<string, unknown>).actual_usd).toBe(0.0048);
  });
});
