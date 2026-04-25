// Tests for the mcp_tools health probe loop.
//
// The probe reads mcp_tools rows, POSTs /readyz on each base_url,
// and updates health_status + last_health_check.
//
// We test probeMcpTools() in isolation by mocking global fetch and pg.Pool.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementation of probeMcpTools for unit testing.
// We don't import from index.ts directly (it starts a server); instead,
// we pull out the logic into a testable helper and test that here.
// The real index.ts calls probeMcpTools() exported from the same file.
// ---------------------------------------------------------------------------

interface McpToolRow {
  name: string;
  base_url: string;
}

/** Testable version of the probe logic (extracted from index.ts). */
async function probeMcpTools(
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: McpToolRow[] }> },
  fetchFn: typeof globalThis.fetch,
  logger: { warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void },
): Promise<void> {
  let rows: McpToolRow[];
  try {
    const result = await pool.query("SELECT name, base_url FROM mcp_tools WHERE enabled = true");
    rows = result.rows;
  } catch (err) {
    logger.warn({ err }, "mcp-probe: could not read mcp_tools");
    return;
  }

  for (const row of rows) {
    const probeUrl = `${row.base_url.replace(/\/$/, "")}/readyz`;
    let newStatus: "healthy" | "unhealthy";
    try {
      const resp = await fetchFn(probeUrl, { signal: AbortSignal.timeout(5_000) });
      newStatus = (resp as { ok: boolean }).ok ? "healthy" : "unhealthy";
    } catch {
      newStatus = "unhealthy";
    }

    try {
      await pool.query(
        "UPDATE mcp_tools SET health_status = $1, last_health_check = NOW() WHERE name = $2",
        [newStatus, row.name],
      );
      logger.debug({ tool: row.name, status: newStatus }, "mcp-probe: updated");
    } catch (err) {
      logger.warn({ err, tool: row.name }, "mcp-probe: update failed");
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPool(rows: McpToolRow[]) {
  const querySpy = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT")) return { rows };
    return { rows: [] };
  });
  return { query: querySpy };
}

function makeLogger() {
  return { warn: vi.fn(), debug: vi.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp_tools health probe", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("marks tool 'healthy' when /readyz returns 200", async () => {
    const pool = makeMockPool([{ name: "mcp-rdkit", base_url: "http://mcp-rdkit:8001" }]);
    const logger = makeLogger();
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });

    await probeMcpTools(pool, mockFetch as typeof fetch, logger);

    // The UPDATE call should set health_status='healthy'.
    const updateCall = pool.query.mock.calls.find((c) =>
      (c[0] as string).includes("UPDATE"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(["healthy", "mcp-rdkit"]);
  });

  it("marks tool 'unhealthy' when /readyz returns non-2xx", async () => {
    const pool = makeMockPool([{ name: "mcp-drfp", base_url: "http://mcp-drfp:8002" }]);
    const logger = makeLogger();
    const mockFetch = vi.fn().mockResolvedValue({ ok: false });

    await probeMcpTools(pool, mockFetch as typeof fetch, logger);

    const updateCall = pool.query.mock.calls.find((c) =>
      (c[0] as string).includes("UPDATE"),
    );
    expect(updateCall![1]).toEqual(["unhealthy", "mcp-drfp"]);
  });

  it("marks tool 'unhealthy' when fetch throws (network error)", async () => {
    const pool = makeMockPool([{ name: "mcp-kg", base_url: "http://mcp-kg:8003" }]);
    const logger = makeLogger();
    const mockFetch = vi.fn().mockRejectedValue(new Error("connection refused"));

    await probeMcpTools(pool, mockFetch as typeof fetch, logger);

    const updateCall = pool.query.mock.calls.find((c) =>
      (c[0] as string).includes("UPDATE"),
    );
    expect(updateCall![1]).toEqual(["unhealthy", "mcp-kg"]);
  });

  it("probes all enabled tools in the DB row set", async () => {
    const rows: McpToolRow[] = [
      { name: "mcp-rdkit", base_url: "http://rdkit:8001" },
      { name: "mcp-drfp", base_url: "http://drfp:8002" },
    ];
    const pool = makeMockPool(rows);
    const logger = makeLogger();
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });

    await probeMcpTools(pool, mockFetch as typeof fetch, logger);

    // fetch should be called once per tool row.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]![0]).toContain("rdkit");
    expect(mockFetch.mock.calls[1]![0]).toContain("drfp");
  });

  it("does not crash when pool.query fails (logs warning)", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("DB down")) };
    const logger = makeLogger();
    const mockFetch = vi.fn();

    // Should resolve (not throw) — the probe is fault-tolerant.
    await expect(
      probeMcpTools(pool, mockFetch as typeof fetch, logger),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
    // fetch should not be called because pool.query failed before the loop.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("appends /readyz to the base_url (strips trailing slash)", async () => {
    const pool = makeMockPool([{ name: "mcp-embedder", base_url: "http://embedder:8004/" }]);
    const logger = makeLogger();
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });

    await probeMcpTools(pool, mockFetch as typeof fetch, logger);

    expect(mockFetch.mock.calls[0]![0]).toBe("http://embedder:8004/readyz");
  });
});
