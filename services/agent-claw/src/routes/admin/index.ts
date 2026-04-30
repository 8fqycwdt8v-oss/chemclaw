// Phase 1 of the configuration concept.
//
// Aggregator for all /api/admin/* routes. Future phases (config_settings,
// feature_flags, redaction_patterns, permission_policies, etc.) register
// their endpoints here so the admin surface stays mounted in one place.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { registerAdminUsersRoutes } from "./admin-users.js";
import { registerAdminAuditRoute } from "./admin-audit.js";

export function registerAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): void {
  registerAdminUsersRoutes(app, pool, getUserEntraId);
  registerAdminAuditRoute(app, pool, getUserEntraId);
}

export { isAdmin, requireAdmin, guardAdmin, AdminPermissionError } from "../../middleware/require-admin.js";
export type { AdminRole } from "../../middleware/require-admin.js";
export { appendAudit, type AuditEntry } from "./audit-log.js";
