// Aggregator for all /api/admin/* routes.
// Phase 1: admin_users, admin_audit.
// Phase 2: admin_config, admin_flags.
// Phase 3: admin_redaction, admin_permissions.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { registerAdminUsersRoutes } from "./admin-users.js";
import { registerAdminAuditRoute } from "./admin-audit.js";
import { registerAdminConfigRoutes } from "./admin-config.js";
import { registerAdminFlagsRoutes } from "./admin-flags.js";
import { registerAdminRedactionRoutes } from "./admin-redaction.js";
import { registerAdminPermissionRoutes } from "./admin-permissions.js";

export function registerAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): void {
  registerAdminUsersRoutes(app, pool, getUserEntraId);
  registerAdminAuditRoute(app, pool, getUserEntraId);
  registerAdminConfigRoutes(app, pool, getUserEntraId);
  registerAdminFlagsRoutes(app, pool, getUserEntraId);
  registerAdminRedactionRoutes(app, pool, getUserEntraId);
  registerAdminPermissionRoutes(app, pool, getUserEntraId);
}

export { isAdmin, requireAdmin, guardAdmin, AdminPermissionError } from "../../middleware/require-admin.js";
export type { AdminRole } from "../../middleware/require-admin.js";
export { appendAudit, type AuditEntry } from "./audit-log.js";
