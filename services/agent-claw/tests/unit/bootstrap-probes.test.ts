// review-v2 cycle-2: replace the inline-copy probe test with a test
// against the REAL `probeMcpTools` exported from bootstrap/probes.ts.
// The pre-fix mcp-health-probe.test.ts pulled in an inline duplicate
// that used `name` columns, while the production module uses
// `service_name`. A column rename in the real code was invisible to
// the inline-copy test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { probeMcpTools, registerReadyzRoute } from "../../src/bootstrap/probes.js";
import type { Pool } from "pg";

function makeApp() {
  const get = vi.fn();
  const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  return {
    get,
    log,
    routeHandlers: get,
  };
}

function makePool(selectRows: Array<{ service_name: string; base_url: string }>) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.toUpperCase().includes("SELECT")) return await Promise.resolve({ rows: selectRows });
    if (sql.toUpperCase().includes("UPDATE")) return await Promise.resolve({ rows: [], rowCount: 1 });
    return await Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query } as unknown as Pool & { query: typeof query };
}

describe("probeMcpTools — real production path", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses the service_name column (regression guard for inline-copy drift)", async () => {
    const app = makeApp();
    const pool = makePool([{ service_name: "mcp-rdkit", base_url: "http://rdkit:8001" }]);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    await probeMcpTools(app as never, pool);

    // The SELECT must reference service_name (not 'name') — this is
    // the bug the inline-copy test masked.
    const selectCall = pool.query.mock.calls.find((c) =>
      String(c[0]).toUpperCase().includes("SELECT"),
    );
    expect(selectCall).toBeDefined();
    expect(String(selectCall![0])).toContain("service_name");

    // The UPDATE must filter WHERE service_name = $2.
    const updateCall = pool.query.mock.calls.find((c) =>
      String(c[0]).toUpperCase().includes("UPDATE"),
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toContain("service_name");
    expect(updateCall![1]).toEqual(["healthy", "mcp-rdkit"]);
  });

  it("marks unhealthy when /readyz returns non-2xx", async () => {
    const app = makeApp();
    const pool = makePool([{ service_name: "mcp-drfp", base_url: "http://drfp:8002" }]);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });

    await probeMcpTools(app as never, pool);

    const updateCall = pool.query.mock.calls.find((c) =>
      String(c[0]).toUpperCase().includes("UPDATE"),
    );
    expect(updateCall![1]).toEqual(["unhealthy", "mcp-drfp"]);
  });

  it("marks unhealthy on fetch network error", async () => {
    const app = makeApp();
    const pool = makePool([{ service_name: "mcp-kg", base_url: "http://kg:8003" }]);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await probeMcpTools(app as never, pool);

    const updateCall = pool.query.mock.calls.find((c) =>
      String(c[0]).toUpperCase().includes("UPDATE"),
    );
    expect(updateCall![1]).toEqual(["unhealthy", "mcp-kg"]);
  });

  it("strips trailing slash from base_url before appending /readyz", async () => {
    const app = makeApp();
    const pool = makePool([{ service_name: "mcp-embedder", base_url: "http://embedder:8004/" }]);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy;

    await probeMcpTools(app as never, pool);

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://embedder:8004/readyz");
  });

  it("survives pool.query failure on the SELECT (logs warn, no UPDATE)", async () => {
    const app = makeApp();
    const failingPool = {
      query: vi.fn().mockRejectedValue(new Error("DB down")),
    } as unknown as Pool;
    globalThis.fetch = vi.fn();

    await expect(probeMcpTools(app as never, failingPool)).resolves.toBeUndefined();
    expect(app.log.warn).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("registerReadyzRoute — three failure modes", () => {
  it("registers /readyz on the app instance", () => {
    const app = makeApp();
    const pool = makePool([]);
    registerReadyzRoute(app as never, pool);
    expect(app.get).toHaveBeenCalledWith("/readyz", expect.any(Function));
  });
});
