# session_purger

TTL daemon evicting expired `agent_sessions` rows. Companion to
`session_reanimator`: the reanimator wakes stalled live sessions,
this daemon evicts dead ones.

## Why

Every `/api/chat` turn touches `agent_sessions` (insert or update).
Without a TTL purger the table grows unbounded — bad for query
plans, the `(user_entra_id, updated_at)` index, and storage cost.

`db/init/13_agent_sessions.sql` declared `expires_at` (default
`NOW() + INTERVAL '7 days'`) but left the eviction "to a future
cron job." This is that cron job.

## What it does

Once per `POLL_INTERVAL_SECONDS` (default 3600s = 1h):

```sql
WITH victims AS (
  SELECT id FROM agent_sessions
   WHERE expires_at < NOW()
     AND created_at < NOW() - make_interval(hours => $MIN_AGE_HOURS)
   ORDER BY expires_at ASC
   LIMIT $BATCH_SIZE
   FOR UPDATE SKIP LOCKED
)
DELETE FROM agent_sessions s USING victims v
 WHERE s.id = v.id
RETURNING s.id::text;
```

Cascade FKs clean up `agent_todos` and `agent_plans` automatically.

`FOR UPDATE SKIP LOCKED` lets two purger replicas (or a purger + a
concurrent UPDATE) coexist without blocking each other.

`MIN_AGE_HOURS` (default 1h) is a hard floor: even if `expires_at`
is past, the row must also be at least that old. Defends against
an accidental `UPDATE agent_sessions SET expires_at = ...` that
backdates a fresh row.

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `postgres` / `5432` / `chemclaw` / `chemclaw_service` / `""` | Postgres connection (must use `chemclaw_service` to delete across users) |
| `POLL_INTERVAL_SECONDS` | `3600` | How often to tick |
| `BATCH_SIZE` | `1000` | Max rows per tick |
| `MIN_AGE_HOURS` | `1` | Hard floor — refuses to purge rows younger than this |
| `LOG_LEVEL` | `INFO` | Python `logging` level |

## Run locally

```bash
python3 -m services.optimizer.session_purger.main
```

Exits cleanly on `SIGINT` / `SIGTERM`; per-tick failures are caught
and logged so a transient DB blip never stalls the loop.

## Run in Docker

```bash
docker build -f services/optimizer/session_purger/Dockerfile \
  -t chemclaw-session-purger .
docker run --rm \
  -e POSTGRES_HOST=postgres \
  -e POSTGRES_PASSWORD=... \
  chemclaw-session-purger
```

## Manual one-shot run

To purge once and exit (e.g., for an ad-hoc cleanup):

```python
import asyncio
from services.optimizer.session_purger.main import Settings, purge_once

async def go():
    s = Settings()
    print(await purge_once(s))

asyncio.run(go())
```

## Tests

`tests/test_session_purger.py` exercises the SQL with a mock
psycopg connection; verifies the bounded-batch contract,
the min-age floor, and that an exception in one tick doesn't
crash the loop.
