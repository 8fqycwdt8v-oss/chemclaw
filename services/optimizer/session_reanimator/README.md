# session_reanimator

Auto-resume daemon for stalled agent-claw sessions. Phase I of the autonomy upgrade — see `docs/plans/agent-claw-autonomy-upgrade.md` and `docs/runbooks/autonomy-upgrade.md`.

## What it does

Every `POLL_INTERVAL_SECONDS` (default 300s = 5 min), finds `agent_sessions` rows where:

- `last_finish_reason ∈ ('max_steps', 'stop')` — never paused on a question
- `auto_resume_count < auto_resume_cap` — under the loop guard
- `session_input_tokens < COALESCE(session_token_budget, AGENT_SESSION_INPUT_TOKEN_BUDGET)`
- has at least one `in_progress` todo
- `updated_at < NOW() - 5 minutes` — gives the user a chance to interject

For each match, POSTs `/api/sessions/:id/resume` on the agent. The agent runs one more harness turn with a synthetic "Continue with the next step" message; the result is logged here so operators can spot patterns.

## Configuration

Read from environment via `pydantic-settings`:

| Var | Default | Purpose |
|---|---|---|
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `postgres` / `5432` / `chemclaw` / `chemclaw_service` / `""` | Postgres connection (must use `chemclaw_service` to read across users) |
| `AGENT_BASE_URL` | `http://agent-claw:3101` | Agent root URL |
| `AGENT_USER_HEADER` | `x-user-entra-id` | Header the agent reads for caller identity |
| `POLL_INTERVAL_SECONDS` | `300` | How often to poll |
| `BATCH_SIZE` | `10` | Max sessions per tick |
| `STALE_AFTER_SECONDS` | `300` | Min idle time before considering stale |
| `LOG_LEVEL` | `INFO` | Python `logging` level |

## Run locally

```bash
python3 -m services.optimizer.session_reanimator.main
```

Exits cleanly on `SIGINT` / `SIGTERM`; per-session failures are caught and logged so a single bad session never stalls the rest of the batch.

## Run in Docker

```bash
docker build -f services/optimizer/session_reanimator/Dockerfile -t chemclaw-session-reanimator .
docker run --rm \
  -e POSTGRES_HOST=postgres \
  -e POSTGRES_PASSWORD=... \
  -e AGENT_BASE_URL=http://agent-claw:3101 \
  chemclaw-session-reanimator
```

## Loop guard

The cap (`agent_sessions.auto_resume_cap`, default 10) is enforced **at the agent**, not at the daemon. The daemon will keep submitting wake calls; the agent's `POST /api/sessions/:id/resume` returns 409 with `{error: "auto_resume_cap_reached"}` once the cap is hit, and the daemon logs + skips. To bump a specific session's cap:

```sql
UPDATE agent_sessions SET auto_resume_cap = 30 WHERE id = '<uuid>';
```

## Open security gap

The daemon impersonates each session's owning user via the `x-user-entra-id` header to satisfy the agent's auth gate. Any pod that can reach the agent's port and forge that header has the same impersonation power. The mint+verify infra for ADR 006 Layer 2 (HS256 JWTs) is in place but not yet wired end-to-end. Until it is, run the daemon and the agent on a private cluster network with NetworkPolicy gates.

## Tests

No unit tests today — the daemon is mostly I/O against the live agent. An integration test that spins up the agent + Postgres and verifies a stale session gets resumed correctly is tracked as a follow-up.
