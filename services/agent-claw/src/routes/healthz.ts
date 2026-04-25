// GET /healthz — liveness probe (no external dependencies checked).
// Phase A.1: minimal. Readiness (Postgres ping) lands in A.2.

import type { FastifyInstance } from "fastify";

export function registerHealthzRoute(app: FastifyInstance): void {
  app.get("/healthz", async () => {
    return { status: "ok" };
  });
}
