// GET /healthz — liveness probe (no external dependencies checked).
// /readyz is registered separately by bootstrap/probes.ts: it both pings
// Postgres and asserts at least one mcp_tools row is healthy.

import type { FastifyInstance } from "fastify";

export function registerHealthzRoute(app: FastifyInstance): void {
  app.get("/healthz", async () => {
    return { status: "ok" };
  });
}
