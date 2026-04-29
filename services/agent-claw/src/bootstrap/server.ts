// Fastify server bootstrap.
//
// Owns:
//   - Fastify instance creation (logger, body limit, request-id genReqId).
//   - Middleware: helmet, cors, rate-limit (parity with the pre-rebuild service).
//   - Auth: getUser() reads x-user-entra-id / dev fallback.
//   - Global error handler: maps MissingUserError → 401 with the standard envelope.
//
// The server returned here has NOT yet had any routes registered. The
// entrypoint composes routeDeps and calls each registerXyzRoute(app, deps)
// afterwards.

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Config } from "../config.js";

/**
 * Thrown when a non-dev request arrives without x-user-entra-id. Mapped
 * to a 401 by the global error handler.
 */
export class MissingUserError extends Error {
  constructor() {
    super("missing x-user-entra-id");
    this.name = "MissingUserError";
  }
}

/**
 * Build a getUser closure bound to `cfg`. Production reads
 * x-user-entra-id from the auth-proxy; dev mode prefers the
 * x-dev-user-entra-id header, then falls back to CHEMCLAW_DEV_USER_EMAIL.
 *
 * Missing header in production throws MissingUserError → 401 via the
 * global error handler. We fail closed rather than silently treating the
 * caller as a real user, because any path here means the auth proxy was
 * bypassed or misconfigured.
 */
export function makeGetUser(cfg: Config): (req: FastifyRequest) => string {
  return (req) => {
    if (cfg.CHEMCLAW_DEV_MODE) {
      const hdr = req.headers["x-dev-user-entra-id"];
      return (typeof hdr === "string" && hdr.length > 0 ? hdr : undefined) ??
        cfg.CHEMCLAW_DEV_USER_EMAIL;
    }
    const hdr = req.headers["x-user-entra-id"];
    if (typeof hdr !== "string" || hdr.length === 0) {
      throw new MissingUserError();
    }
    return hdr;
  };
}

/**
 * Build the Fastify instance + register security plugins (helmet, cors,
 * rate-limit) + install the global error handler. The instance is
 * returned WITHOUT routes attached — the entrypoint composes routeDeps
 * and calls each `registerXyzRoute(app, deps)` afterwards.
 */
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
      if (!origin) return cb(null, true); // curl / server-to-server
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("origin not allowed"), false);
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

  // Map MissingUserError → 401 with the standard envelope so missing-auth-header
  // failures don't surface as opaque 500s.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof MissingUserError) {
      return reply.code(401).send({
        error: "unauthenticated",
        detail: "x-user-entra-id header is required",
      });
    }
    // Default Fastify error handler — preserves prior behavior for
    // everything else.
    req.log.error({ err }, "unhandled error");
    // err is typed as FastifyError | Error | unknown across Fastify
    // versions; narrow defensively before reading statusCode/message.
    const e = err as { statusCode?: number; message?: string };
    reply.code(e.statusCode ?? 500).send({
      error: "internal",
      detail: cfg.CHEMCLAW_DEV_MODE ? e.message : undefined,
    });
  });

  return app;
}
