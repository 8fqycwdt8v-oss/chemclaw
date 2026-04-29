// Health probes + MCP-tools probe loop.
//
// Owns:
//   - GET /healthz registration (delegates to routes/healthz.ts)
//   - GET /readyz handler — Postgres ping + mcp_tools health row check
//   - probeMcpTools(): one-shot probe of every enabled mcp_tools row's
//     /readyz endpoint, updating health_status + last_health_check.
//   - startMcpProbeLoop(): kicks off the recurring probe loop.
//
// The probe loop is deliberately fire-and-forget — the caller doesn't
// await it. The first run delays by `MCP_HEALTH_PROBE_INTERVAL_MS` to
// avoid stampeding fresh-start traffic; that means /readyz can return
// `no_healthy_mcp_tools` for up to one interval after boot, which is
// the documented behaviour.

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerHealthzRoute } from "../routes/healthz.js";

export const MCP_HEALTH_PROBE_INTERVAL_MS = 60_000;

interface McpToolRow {
  service_name: string;
  base_url: string;
}

/**
 * Probe every enabled mcp_tools row's /readyz endpoint and update
 * health_status + last_health_check in Postgres. Best-effort: a probe
 * failure marks the row unhealthy, a query failure logs and returns.
 *
 * Exported so tests can drive the probe synchronously. Production calls
 * it via `startMcpProbeLoop`.
 */
export async function probeMcpTools(
  app: FastifyInstance,
  pool: Pool,
): Promise<void> {
  let rows: McpToolRow[];
  try {
    const result = await pool.query<McpToolRow>(
      "SELECT service_name, base_url FROM mcp_tools WHERE enabled = true",
    );
    rows = result.rows;
  } catch (err) {
    app.log.warn({ err }, "mcp-probe: could not read mcp_tools");
    return;
  }

  for (const row of rows) {
    const probeUrl = `${row.base_url.replace(/\/$/, "")}/readyz`;
    let newStatus: "healthy" | "unhealthy";
    try {
      const resp = await fetch(probeUrl, { signal: AbortSignal.timeout(5_000) });
      newStatus = resp.ok ? "healthy" : "unhealthy";
    } catch {
      newStatus = "unhealthy";
    }

    try {
      await pool.query(
        `UPDATE mcp_tools
            SET health_status = $1, last_health_check = NOW()
          WHERE service_name = $2`,
        [newStatus, row.service_name],
      );
      app.log.debug({ tool: row.service_name, status: newStatus }, "mcp-probe: updated");
    } catch (err) {
      app.log.warn({ err, tool: row.service_name }, "mcp-probe: update failed");
    }
  }
}

/**
 * Register liveness + readiness probes on the supplied app. /healthz
 * delegates to the existing route module; /readyz is owned here.
 */
export function registerProbeRoutes(
  app: FastifyInstance,
  deps: { pool: Pool },
): void {
  const { pool } = deps;
  registerHealthzRoute(app);

  app.get("/readyz", async (_req, reply) => {
    // 1. Postgres ping.
    try {
      await pool.query("SELECT 1");
    } catch (err) {
      app.log.warn({ err }, "readyz: Postgres not reachable");
      return reply.code(503).send({ status: "not_ready", reason: "postgres_unreachable" });
    }

    // 2. At least one mcp_tools row must be healthy.
    try {
      const { rowCount } = await pool.query(
        "SELECT 1 FROM mcp_tools WHERE health_status = 'healthy' AND enabled = true LIMIT 1",
      );
      if (!rowCount || rowCount === 0) {
        return reply
          .code(503)
          .send({ status: "not_ready", reason: "no_healthy_mcp_tools" });
      }
    } catch (err) {
      app.log.warn({ err }, "readyz: mcp_tools query failed");
      return reply
        .code(503)
        .send({ status: "not_ready", reason: "mcp_tools_query_failed" });
    }

    return { status: "ready" };
  });
}

/**
 * Start the recurring mcp_tools health probe. The loop is fire-and-forget;
 * the first run is delayed by `MCP_HEALTH_PROBE_INTERVAL_MS`, matching
 * the pre-rebuild behaviour documented in the audit.
 */
export function startMcpProbeLoop(
  app: FastifyInstance,
  pool: Pool,
  intervalMs: number = MCP_HEALTH_PROBE_INTERVAL_MS,
): void {
  const runProbeLoop = async () => {
    await probeMcpTools(app, pool);
    setTimeout(() => void runProbeLoop(), intervalMs);
  };
  setTimeout(() => void runProbeLoop(), intervalMs);
}
