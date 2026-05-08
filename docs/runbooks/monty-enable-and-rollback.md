# Runbook: Monty code-mode runtime — enable, tune, kill-switch

Monty is the optional code-mode orchestration runtime that the
`run_orchestration_script` builtin spawns to execute Python orchestration
scripts in a sandboxed subprocess. The runtime is **disabled by default**
(`monty.enabled = false` in `db/init/40_monty_config_seeds.sql`); the
agent falls back to sequential ReAct without it.

This runbook covers:

- enabling the runtime in a tenant
- tuning the resource caps live
- the kill-switch path (incident response)
- error codes to watch in `error_events` / Loki

All knobs resolve through the standard `config_settings` chain
(user → project → org → global, 60 s TTL); admin mutations bust the
cache. Source of truth: `services/agent-claw/src/runtime/monty/limits.ts`.

## 1. Enable the runtime

Two settings must be true together for the runtime to spin up:

| Key | Value | What it does |
|---|---|---|
| `monty.binary_path` | absolute path to the Monty runner binary | empty string → runtime refuses to start |
| `monty.enabled` | `true` | master switch |

Order matters: set `binary_path` BEFORE flipping `enabled`. The
`run_orchestration_script` builtin's preflight returns a clear
`runtime_disabled` envelope when either is missing, and the agent falls
back to sequential ReAct without losing the user turn.

```bash
# 1. Point at the installed binary (global default).
curl -X PATCH -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/config/global/?key=monty.binary_path&value=/opt/monty/bin/monty-runner"

# 2. Flip the master switch.
curl -X PATCH -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/config/global/?key=monty.enabled&value=true"

# 3. Verify the warm pool spawned (4 children by default).
curl "$AGENT_BASE_URL/api/healthz" | jq .runtime.monty
# → { "enabled": true, "warmPoolSize": 4, "available": 4 }
```

The pool pre-spawns `monty.warm_pool_size` children at first use; the
slow-path waits for the child's READY frame (bounded by the host's
`READY_TIMEOUT_MS`) and wraps in `PrewarmedChildWrapper` so a cold spawn
doesn't trip the next call's wall-time budget.

## 2. Per-tenant enablement

Same endpoint, scoped to org or project (RBAC: `global_admin` for
global, `org_admin <org_id>` for org, `project_admin <project_id>` for
project):

```bash
# Project-scoped enable (overrides the global default for that project).
curl -X PATCH -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/config/project/$PROJECT_ID?key=monty.enabled&value=true"
```

The 60 s TTL applies — first request after the mutation may still see
the stale value.

## 3. Tune resource caps

| Key | Default | Floor / ceiling | What it caps |
|---|---|---|---|
| `monty.wall_time_ms` | 30 000 (30 s) | 1 000 / 600 000 | Per-script wall-clock cap |
| `monty.max_external_calls` | 32 | 0 / 1 024 | Per-script `external_function` calls |
| `monty.warm_pool_size` | 4 | 0 / 32 | Pre-spawned children |

Limits.ts clamps every value into the floor/ceiling range, so a
misconfigured row can't disable the wall-time entirely or spawn 1000
warm children. Setting `max_external_calls` to `0` effectively turns
the runtime into a "no tool calls allowed" mode useful for
plan-only orchestration.

```bash
# Bump the wall-time to 2 minutes for one project running deep
# retrieval orchestrations.
curl -X PATCH -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/config/project/$PROJECT_ID?key=monty.wall_time_ms&value=120000"
```

## 4. Kill switch (incident response)

Two paths, listed in increasing blast radius.

### 4a. Disable in one tenant

```bash
curl -X PATCH -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/config/project/$PROJECT_ID?key=monty.enabled&value=false"
```

Effective within 60 s. Existing in-flight scripts run to completion
(or wall-time); new calls return `runtime_disabled` and the agent falls
back to ReAct.

### 4b. Disable globally + drain the pool

```bash
# Global disable — overrides every nested scope.
curl -X PATCH -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/config/global/?key=monty.enabled&value=false"

# Optional: drain the pool to free child processes immediately.
# Set warm_pool_size=0; the pool's GC cleans up idle children on its
# next sweep.
curl -X PATCH -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/config/global/?key=monty.warm_pool_size&value=0"
```

If the agent is in a crashloop because the runtime itself is broken
(child crashes, ready-frame timeouts), restart the agent-claw pod —
the pool is process-local and reseeds from the (now disabled or
shrunk) config on next boot.

`run_orchestration_script` is in `FORBIDDEN_TOOL_IDS` for sub-agents,
so the kill-switch is enforced at the call-site even if a sub-agent
is mid-script when the toggle flips.

## 5. Error codes to watch

All runtime failures land structured in Loki under
`component=agent-claw.runtime.monty.{host,pool,child}` AND the
`error_events` audit table (when wired — see BACKLOG
`[observability/error_events]` for the rollout status).

| `event` | What it means | Action |
|---|---|---|
| `monty_pool_spawn_failed` | Child spawn failed (binary missing, perms wrong) | Verify `monty.binary_path` exists + is executable inside the agent-claw container |
| `monty_pool_ready_timeout` | Child spawned but didn't send READY in time | Slow startup — bump `READY_TIMEOUT_MS` env or investigate the runner's init path |
| `monty_ready_timeout` | Slow-path child never became ready | Same as above, but for an unprewarmed call. Frequent → `warm_pool_size` is too low |
| `monty_wall_time_exceeded` | Script ran past `monty.wall_time_ms` | Either bump the cap (per-tenant) or investigate the script for unbounded loops |
| `monty_child_adapter_error` | JSON-RPC framing / protocol error from child | Likely runner version mismatch — verify the binary matches the host's expected protocol version |
| `monty_external_call_dispatch_failed` | A tool call from inside Monty failed at the agent-side dispatcher | Inspect `monty.run_id` in the surrounding span — the failed tool is named in the next log line. Real failures (network, permission) propagate as outcome=error to the script |
| `monty_external_response_send_failed` | Host couldn't send the tool result back to the child (child crashed mid-call) | Combined with `monty_child_adapter_error` typically means the child died — check OS-level limits (open files, memory) |

## 6. Telemetry / dashboards

OpenTelemetry spans emit canonical `tool.id` / `tool.read_only` /
`tool.in_batch` attributes alongside `monty.*` so dashboards keyed
on `tool.id` find Monty calls without special-casing. Span names:

- `monty.external_call` — one per external_function dispatch (carries
  `monty.external_call.tool_id`, `monty.external_call.id`,
  `monty.run_id`, `monty.outcome`).
- `monty.run` (root) — one per script execution (carries
  `monty.run_id`, `monty.outcome`, `monty.external_calls_count`,
  `monty.wall_time_ms` actual).

A `monty.run_id`-keyed dashboard JSON ships separately — see BACKLOG
`[agent-claw/runtime/monty] ship a Langfuse dashboard config`.

## 7. Restoring service after rollback

If the kill-switch was hit and the underlying issue is fixed:

1. Verify the binary is healthy: `monty-runner --version` returns the
   expected protocol version.
2. Re-enable globally OR per-tenant (4a/4b in reverse).
3. Watch `event=monty_pool_spawn_failed` for the first 5 minutes
   post-enable. A clean spin-up emits zero failure events; the warm
   pool reaches `monty.warm_pool_size` available children within
   `READY_TIMEOUT_MS`.

If failures recur, leave the runtime disabled and file a follow-up
in `BACKLOG.md` with the run_ids and error_events rows.
