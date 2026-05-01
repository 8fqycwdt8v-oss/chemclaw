// Fastify server construction + security plugins.
//
// Extracted from index.ts as part of the PR-6 god-file split. The Fastify
// instance is async-built because helmet/cors/rate-limit registration is
// awaited; index.ts then layers routes/probes/dependencies onto the
// returned app.
//
// Security parity with the legacy services/agent path is intentional —
// any deviation here changes the public security posture, so add a test
// before changing defaults.

import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Config } from "../config.js";

export async function buildServer(cfg: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: cfg.AGENT_LOG_LEVEL,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie"],
        censor: "***",
      },
    },
    // Body size cap matches legacy agent (Phase A.4 parity).
    bodyLimit: cfg.AGENT_BODY_LIMIT_BYTES,
    disableRequestLogging: false,
    trustProxy: 1,
    genReqId: (req) => {
      const rid = req.headers["x-request-id"];
      return (typeof rid === "string" ? rid : undefined) ?? crypto.randomUUID();
    },
  });

  // Helmet: HTTP security headers. CSP is off for a JSON API.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });

  // CORS: explicit allowlist from config.
  const allowedOrigins = cfg.AGENT_CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) { cb(null, true); return; } // curl / server-to-server
      if (allowedOrigins.includes(origin)) { cb(null, true); return; }
      cb(new Error("origin not allowed"), false);
    },
    credentials: true,
  });

  // Global rate limit (per IP / user header). Probes are always exempt.
  await app.register(rateLimit, {
    max: cfg.AGENT_RATE_LIMIT_MAX,
    timeWindow: cfg.AGENT_RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => {
      const u = req.headers["x-user-entra-id"] ?? req.headers["x-forwarded-user"];
      if (typeof u === "string" && u.length > 0) return `user:${u}`;
      return `ip:${req.ip}`;
    },
    // Probes must stay cheap — never rate-limit them.
    allowList: (req) => req.url === "/healthz" || req.url === "/readyz",
  });

  // Echo `x-request-id` on every response so clients can correlate a
  // failure ticket back to a server log line + Langfuse trace. The id
  // itself comes from `genReqId` above (header → fallback UUID); this
  // hook just makes sure it appears on the wire even when a handler
  // never explicitly set it. Skips probes to keep them as cheap as
  // possible (k8s probes don't need correlation).
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url !== "/healthz" && req.url !== "/readyz") {
      reply.header("x-request-id", req.id);
    }
    return payload;
  });

  return await app;
}
