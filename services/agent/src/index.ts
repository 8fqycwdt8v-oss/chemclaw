// ChemClaw agent service — Fastify HTTP entrypoint.
//
// Exposes:
//   GET  /healthz                          — liveness (no deps)
//   GET  /readyz                           — readiness (Postgres ping)
//   GET  /api/projects                     — projects visible to caller (RLS)
//   POST /api/tools/find_similar_reactions — DRFP cosine search (RLS)
//
// Security posture:
//   - helmet HTTP headers
//   - explicit CORS origin allowlist (config, not hardcoded)
//   - rate limit per user/IP (120/min default)
//   - body size cap (1 MiB default)
//   - x-forwarded-user trusted ONLY in dev mode; in prod the upstream
//     oauth2-proxy MUST strip and replace this header.

import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import type { Pool } from "pg";

import { loadConfig } from "./config.js";
import { createPool, withUserContext } from "./db.js";
import { McpDrfpClient, UpstreamError } from "./mcp-clients.js";
import {
  findSimilarReactions,
  FindSimilarReactionsInput,
} from "./tools/find-similar-reactions.js";

const config = loadConfig();

const app = Fastify({
  logger: {
    level: config.AGENT_LOG_LEVEL,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      censor: "***",
    },
  },
  bodyLimit: config.AGENT_BODY_LIMIT_BYTES,
  disableRequestLogging: false,
  trustProxy: 1,
  genReqId: (req) =>
    (typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : undefined) ?? crypto.randomUUID(),
});

await app.register(helmet, {
  contentSecurityPolicy: false, // JSON API; CSP not applicable
  crossOriginResourcePolicy: { policy: "same-site" },
});

const allowedOrigins = config.AGENT_CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("origin not allowed"), false);
  },
  credentials: true,
});

await app.register(rateLimit, {
  max: config.AGENT_RATE_LIMIT_MAX,
  timeWindow: config.AGENT_RATE_LIMIT_WINDOW_MS,
  keyGenerator: (req) => {
    const u = req.headers["x-forwarded-user"];
    if (typeof u === "string" && u.length > 0) return `user:${u}`;
    return `ip:${req.ip}`;
  },
  // Probes must stay cheap — never rate-limit them.
  allowList: (req) => req.url === "/healthz" || req.url === "/readyz",
});

await app.register(sensible);

const pool: Pool = createPool(config);
const drfpClient = new McpDrfpClient(config.MCP_DRFP_URL);

app.get("/healthz", async () => ({ status: "ok" }));

app.get("/readyz", async (_req, reply) => {
  try {
    const res = await pool.query("SELECT 1 AS ok");
    if (res.rows[0]?.ok === 1) {
      return { status: "ok", postgres: "up" };
    }
    return reply.code(503).send({ status: "degraded", postgres: "unexpected_response" });
  } catch (err) {
    app.log.error({ err }, "readyz postgres check failed");
    return reply.code(503).send({ status: "down", postgres: "unreachable" });
  }
});

// --- Authenticated user extraction -----------------------------------------
// IMPORTANT: In production, oauth2-proxy MUST strip any client-supplied
// X-Forwarded-User header and inject its own (from the validated OIDC token)
// before forwarding to this service. Without that stripping, a malicious
// client could impersonate users by sending the header directly.
function getUserFromRequest(req: FastifyRequest): string {
  if (config.CHEMCLAW_DEV_MODE) {
    return config.CHEMCLAW_DEV_USER_EMAIL;
  }
  const u = req.headers["x-forwarded-user"];
  // RFC 5321 caps email length at 320; be a little more generous for
  // upstream-decorated identifiers while still preventing abuse.
  if (typeof u === "string" && u.length > 0 && u.length <= 320) return u;
  throw app.httpErrors.unauthorized("missing or invalid x-forwarded-user header");
}

app.get("/api/projects", async (req, reply) => {
  const user = getUserFromRequest(req);
  try {
    const rows = await withUserContext(pool, user, async (client) => {
      const r = await client.query(
        `SELECT id, internal_id, name, therapeutic_area, phase, status
           FROM nce_projects
          ORDER BY internal_id`,
      );
      return r.rows;
    });
    return { user, projects: rows };
  } catch (err) {
    req.log.error({ err }, "projects query failed");
    return reply.code(500).send({ error: "internal" });
  }
});

app.post("/api/tools/find_similar_reactions", async (req, reply) => {
  const user = getUserFromRequest(req);
  const parsed = FindSimilarReactionsInput.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "invalid_input",
      detail: parsed.error.issues.map((i) => ({ path: i.path, msg: i.message })),
    });
  }
  try {
    return await findSimilarReactions(parsed.data, {
      pool,
      drfp: drfpClient,
      userEntraId: user,
    });
  } catch (err) {
    if (err instanceof UpstreamError) {
      req.log.warn({ service: err.service, status: err.status }, "upstream failed");
      return reply.code(502).send({ error: "upstream_unavailable", service: err.service });
    }
    req.log.error({ err }, "find_similar_reactions failed");
    return reply.code(500).send({ error: "internal" });
  }
});

// --- Startup ---------------------------------------------------------------
const start = async () => {
  try {
    await app.listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
  } finally {
    await pool.end();
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await start();
