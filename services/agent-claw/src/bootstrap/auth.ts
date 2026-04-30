// User-identity extraction + global error handler.
//
// Extracted from index.ts as part of the PR-6 god-file split. The
// `getUser(req)` function is the single source of truth for "which user
// is making this request" — every route registrar receives it via the
// route deps object.
//
// Production: x-user-entra-id is required (set by the upstream auth proxy).
// Dev mode (CHEMCLAW_DEV_MODE=true): falls back to x-dev-user-entra-id
// or CHEMCLAW_DEV_USER_EMAIL so local curl works without an auth proxy.
// Missing-header in production fails closed with 401 — never silently
// downgraded to "system" or "anonymous".

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";

/**
 * Thrown when a non-dev request arrives without x-user-entra-id. Mapped to
 * a 401 by the global error handler below.
 */
class MissingUserError extends Error {
  constructor() {
    super("missing x-user-entra-id");
    this.name = "MissingUserError";
  }
}

/**
 * Wire the MissingUserError → 401 mapping into Fastify's setErrorHandler
 * and return the `getUser` extraction function the route registrars need.
 */
export function setupAuthAndErrorHandler(
  app: FastifyInstance,
  cfg: Config,
): (req: FastifyRequest) => string {
  // User extraction:
  //   - dev mode: prefer x-dev-user-entra-id, else CHEMCLAW_DEV_USER_EMAIL.
  //   - production: REQUIRE x-user-entra-id from the auth proxy. Missing header
  //     means the auth proxy was bypassed or misconfigured — fail closed with 401
  //     rather than silently treating the caller as a real user.
  const getUser = (req: { headers: Record<string, string | string[] | undefined> }): string => {
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

  // Map MissingUserError → 401 with the standard envelope so missing-auth-header
  // failures don't surface as opaque 500s.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof MissingUserError) {
      return reply.code(401).send({
        error: "unauthenticated",
        detail: "x-user-entra-id header is required",
      });
    }
    // Default Fastify error handler — preserves prior behavior for everything else.
    req.log.error({ err }, "unhandled error");
    // err is typed as FastifyError | Error | unknown across Fastify versions;
    // narrow defensively before reading statusCode/message.
    const e = err as { statusCode?: number; message?: string };
    return reply.code(e.statusCode ?? 500).send({
      error: "internal",
      detail: cfg.CHEMCLAW_DEV_MODE ? e.message : undefined,
    });
  });

  return getUser;
}
