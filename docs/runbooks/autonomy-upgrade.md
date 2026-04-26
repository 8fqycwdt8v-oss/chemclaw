# Autonomy upgrade — operational runbook

Operating the persistent-session / TodoWrite / clarification / chained-plan / auto-resume infrastructure that shipped on the `fix/post-v1.0.0-hardening` branch. Pair with `docs/plans/agent-claw-autonomy-upgrade.md` (design) and `docs/runbooks/post-v1.0.0-hardening.md` (Round 1 deployment).

## What was added

| Component | File / location |
|---|---|
| `agent_sessions` + `agent_todos` tables | `db/init/13_agent_sessions.sql` |
| `agent_plans` + etag + budget counters | `db/init/14_agent_session_extensions.sql` |
| `manage_todos` builtin | `services/agent-claw/src/tools/builtins/manage_todos.ts` |
| `ask_user` builtin | `services/agent-claw/src/tools/builtins/ask_user.ts` |
| Session helpers | `services/agent-claw/src/core/session-store.ts` |
| Plan v2 storage | `services/agent-claw/src/core/plan-store-db.ts` |
| Chained execution | `services/agent-claw/src/routes/sessions.ts` (`POST /api/sessions/:id/plan/run`) |
| Auto-resume endpoint | same file (`POST /api/sessions/:id/resume`) |
| Auto-resume daemon | `services/optimizer/session_reanimator/main.py` |
| Shared harness factory | `services/agent-claw/src/core/harness-builders.ts` |

## Schema migration on an existing v1.0.0 deployment

Both files are idempotent (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` / `CREATE POLICY`, `CREATE OR REPLACE FUNCTION`).

```bash
# As the chemclaw owner role:
psql -U chemclaw -d chemclaw -f db/init/13_agent_sessions.sql
psql -U chemclaw -d chemclaw -f db/init/14_agent_session_extensions.sql
```

Verify:

```sql
\d agent_sessions
\d agent_todos
\d agent_plans
SELECT routine_name FROM information_schema.routines WHERE routine_name = 'agent_sessions_regen_etag';
```

The etag trigger should regenerate on every UPDATE to scratchpad / last_finish_reason / awaiting_question / message_count / session_input_tokens / session_output_tokens / session_steps / auto_resume_count.

## New env vars (override defaults in production)

```
AGENT_SESSION_INPUT_TOKEN_BUDGET=1000000   # per-session input cap; trips SessionBudgetExceededError
AGENT_SESSION_OUTPUT_TOKEN_BUDGET=200000   # per-session output cap
AGENT_PLAN_MAX_AUTO_TURNS=10                # plan/run chain depth cap
```

For the reanimator daemon (`services/optimizer/session_reanimator/`):

```
AGENT_BASE_URL=http://agent-claw:3101
AGENT_USER_HEADER=x-user-entra-id
POLL_INTERVAL_SECONDS=300                   # 5 min
BATCH_SIZE=10
STALE_AFTER_SECONDS=300                     # how long since updated_at before considering stale
```

## Operational tasks

### Inspect a live session
```bash
curl -H "x-user-entra-id: alice@corp.com" http://localhost:3101/api/sessions/<uuid> | jq
```

### List a user's recent sessions
```bash
curl -H "x-user-entra-id: alice@corp.com" "http://localhost:3101/api/sessions?limit=20" | jq
```

### Bump a session's auto-resume cap
A user has a long-running investigation that hit the cap. Bump it:
```sql
UPDATE agent_sessions
   SET auto_resume_cap = 30
 WHERE id = '<uuid>'
   AND user_entra_id = '<email>';
```
The `auto_resume_count` column persists across runs; reset it to 0 if you want a fresh window:
```sql
UPDATE agent_sessions
   SET auto_resume_count = 0,
       auto_resume_cap = 30
 WHERE id = '<uuid>'
   AND user_entra_id = '<email>';
```

### Per-session token budget override
Default is `AGENT_SESSION_INPUT_TOKEN_BUDGET` from env. Override per session:
```sql
UPDATE agent_sessions
   SET session_token_budget = 5000000
 WHERE id = '<uuid>';
```

### Drain (force-stop) a runaway session
```sql
UPDATE agent_sessions
   SET last_finish_reason = 'stop',
       awaiting_question = NULL,
       auto_resume_cap = 0
 WHERE id = '<uuid>';

UPDATE agent_plans
   SET status = 'cancelled'
 WHERE session_id = '<uuid>'
   AND status IN ('proposed', 'approved', 'running');
```
The reanimator skips sessions with `auto_resume_count >= auto_resume_cap`, so setting cap=0 stops auto-resume cold.

### Clear an awaiting_user_input on behalf of the user
The user has gone on holiday but ops needs to unstick the session:
```sql
UPDATE agent_sessions
   SET awaiting_question = NULL,
       last_finish_reason = 'stop'
 WHERE id = '<uuid>';
```
Subsequent reanimator wakes will treat it as resumable.

### Reading reanimator logs
Set `LOG_LEVEL=DEBUG` for verbose output. Per-session messages include `session_id`, `user_entra_id`, attempt count, and the agent's `final_finish_reason`. A pattern of `session X resume failed (409): {error: 'auto_resume_cap_reached'}` is normal — it means the cap fired and the daemon respects it.

## Reanimator deployment

The daemon is a Python apscheduler-style loop. A Dockerfile is included
(`services/optimizer/session_reanimator/Dockerfile`); a docker-compose
service entry needs to be added per deployment. The daemon connects to:

- Postgres (as `chemclaw_service`, BYPASSRLS)
- The agent service (over HTTP, using `x-user-entra-id` header)

**Inter-service auth gap:** The daemon currently impersonates each session's
owning user via `x-user-entra-id` to satisfy the agent's auth gate. Any pod
that can reach the agent's port and forge that header gets the same access.
This is fine when the agent is reachable only via an in-cluster network
(no NetworkPolicy bypass) but is the open piece of ADR 006 Layer 2 that's
still pending. The mint+verify code exists in `src/security/mcp-tokens.ts`
and `services/mcp_tools/common/auth.py` but isn't wired end-to-end. See
"Pending follow-ups" below.

## Pending follow-ups (not yet shipped)

1. **MCP Bearer-token end-to-end wire**: thread `signMcpToken` into every outbound `postJson` / `getJson` in `services/agent-claw/src/`; attach `Depends(require_mcp_token)` to every `/tools/*` route in `services/mcp_tools/common/app.py`. Setting `MCP_AUTH_REQUIRED=true` today would lock the cluster out.
2. **Reanimator → agent JWT**: same JWT mint should be used by the reanimator instead of forging `x-user-entra-id`.
3. **Plan v2 step-by-step**: `agent_plans.steps` is currently decorative — the chained runner just feeds "Continue" prompts and lets the LLM decide what to do next. Walking the stored plan steps explicitly is a follow-up.
4. **Sandbox isolation Layers 1 + 3** (custom E2B template with iptables firewall, sandbox→agent RPC bridge for hook re-injection): tracked in `docs/adr/006-sandbox-isolation.md`. Multi-week.

## Rollback

The autonomy infrastructure is additive — it can be disabled at the route layer without DB changes by:

1. Skipping registration of `manage_todos` and `ask_user` in `services/agent-claw/src/index.ts` (comment out the two `registry.registerBuiltin` lines).
2. Skipping `registerSessionsRoute(...)` in `services/agent-claw/src/index.ts`.
3. Stopping the reanimator daemon.

Existing sessions / todos / plans persist in the DB but are ignored. Re-enabling by re-registering the routes and tools picks up state cleanly.

To **drop the schema**:
```sql
DROP TABLE IF EXISTS agent_plans;
DROP TABLE IF EXISTS agent_todos;
DROP TABLE IF EXISTS agent_sessions;
DROP FUNCTION IF EXISTS agent_sessions_regen_etag();
```
This is destructive — all session state is lost.
