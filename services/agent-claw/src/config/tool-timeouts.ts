// Resolves per-tool timeouts from config_settings, falling back to a hardcoded
// default. Keys: `tool.timeout_ms.<tool_id>` (e.g. tool.timeout_ms.qm_geometry_opt).
//
// Usage:
//   const timeoutMs = await getToolTimeoutMs("qm_geometry_opt", { user: ctx.userEntraId }, 120_000);
//
// The default carries the tool's historical literal so behaviour is unchanged
// when no row exists. Operators override per-tenant via
// `PATCH /api/admin/config/<scope>/<scope_id>?key=tool.timeout_ms.<tool_id>`.
//
// Why separate from the tool body: the timeout must be resolved before the
// outbound HTTP call is made, but every tool already passes `timeoutMs` to
// `postJson`/`getJson`. This helper is one async line at the call site.
//
// Review §2.5.

import { type ConfigContext, getConfigRegistry } from "./registry.js";

/**
 * Resolve the runtime timeout (ms) for a tool. Falls back to `defaultMs` if
 * the registry has no override or is unreachable. Cached for 60 s.
 */
export async function getToolTimeoutMs(
  toolId: string,
  ctx: ConfigContext,
  defaultMs: number,
): Promise<number> {
  try {
    return await getConfigRegistry().getNumber(
      `tool.timeout_ms.${toolId}`,
      ctx,
      defaultMs,
    );
  } catch {
    return defaultMs;
  }
}
