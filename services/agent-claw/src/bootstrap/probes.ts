// /readyz handler + mcp_tools health probe loop.
//
// Extracted from index.ts as part of the PR-6 god-file split. /healthz
// is registered separately by routes/healthz.ts (it has no deps).
//
// The probe loop pings every enabled mcp_tools row's /readyz endpoint
// every 60s and writes the result back into the row's health_status
// column. /readyz reads from that column rather than fanning out at
// request time — keeps probe latency bounded for k8s liveness checks.

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

const MCP_HEALTH_PROBE_INTERVAL_MS = 60_000;

interface McpToolRow {
  service_name: string;
  base_url: string;
}

/**
 * Register `GET /readyz` on the Fastify app. The handler pings Postgres and
 * checks that at least one mcp_tools row is healthy; both must pass for a
 * 200, otherwise a 503 with a typed `reason` field.
 */
export function registerReadyzRoute(app: FastifyInstance, pool: Pool): void {
  app.get("/readyz", async (_req, reply) => {
    // 1. Postgres ping.
    try {
      await pool.query("SELECT 1");
    } catch (err) {
      app.log.warn({ err }, "readyz: Postgres not reachable");
      return await reply.code(503).send({ status: "not_ready", reason: "postgres_unreachable" });
    }

    // 2. At least one mcp_tools row must be healthy.
    try {
      const { rowCount } = await pool.query(
        "SELECT 1 FROM mcp_tools WHERE health_status = 'healthy' AND enabled = true LIMIT 1",
      );
      if (!rowCount || rowCount === 0) {
        return await reply
          .code(503)
          .send({ status: "not_ready", reason: "no_healthy_mcp_tools" });
      }
    } catch (err) {
      app.log.warn({ err }, "readyz: mcp_tools query failed");
      return await reply
        .code(503)
        .send({ status: "not_ready", reason: "mcp_tools_query_failed" });
    }

    return { status: "ready" };
  });
}

/**
 * One pass of the probe loop. Exported so the startup sequence (and tests)
 * can invoke it directly. Catches per-row errors so one bad mcp service
 * doesn't abort the whole pass.
 */
export async function probeMcpTools(app: FastifyInstance, pool: Pool): Promise<void> {
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
 * Kick off the recurring probe loop. The first invocation is delayed by
 * MCP_HEALTH_PROBE_INTERVAL_MS so the listening server is fully up before
 * we start hitting downstreams.
 */
export function startMcpProbeLoop(app: FastifyInstance, pool: Pool): void {
  const runProbeLoop = async (): Promise<void> => {
    await probeMcpTools(app, pool);
    setTimeout(() => void runProbeLoop(), MCP_HEALTH_PROBE_INTERVAL_MS);
  };
  setTimeout(() => void runProbeLoop(), MCP_HEALTH_PROBE_INTERVAL_MS);
}
