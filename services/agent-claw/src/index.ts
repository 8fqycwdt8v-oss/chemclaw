// ChemClaw agent-claw service — Fastify HTTP entrypoint.
// Phase A.1: minimal bootstrap. Port 3101 (legacy agent is 3100).
//
// Exposes:
//   GET /healthz  — liveness (no deps)
//
// Phase A.2 will add:
//   GET  /readyz       — readiness (Postgres ping)
//   POST /api/chat     — SSE streaming chat
//   POST /api/slash    — slash command router

import Fastify from "fastify";
import { registerHealthzRoute } from "./routes/healthz.js";

const PORT = parseInt(process.env["AGENT_CLAW_PORT"] ?? "3101", 10);
const HOST = process.env["AGENT_CLAW_HOST"] ?? "0.0.0.0";
const LOG_LEVEL = process.env["AGENT_CLAW_LOG_LEVEL"] ?? "info";

const app = Fastify({
  logger: {
    level: LOG_LEVEL,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      censor: "***",
    },
  },
  disableRequestLogging: false,
  trustProxy: 1,
  genReqId: (req) => {
    const rid = req.headers["x-request-id"];
    return (typeof rid === "string" ? rid : undefined) ?? crypto.randomUUID();
  },
});

registerHealthzRoute(app);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
const start = async () => {
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down agent-claw");
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await start();
