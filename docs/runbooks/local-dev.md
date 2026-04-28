# Local development runbook

This runbook brings the Phase-0 local stack up from a clean checkout and
verifies it end-to-end. Target time: 10 minutes on a laptop with Docker.

## Prerequisites

- macOS or Linux
- Docker 24+ and Docker Compose v2 (`docker compose ps` works)
- Python 3.11+
- Node.js 22+ (or Bun — adjust commands if using Bun)
- `make` (Homebrew / apt package)

Check versions:

```bash
docker --version && docker compose version
python3 --version
node --version
make --version
```

## 1. Configure environment

```bash
cp .env.example .env
# Edit .env: at minimum set POSTGRES_PASSWORD and NEO4J_PASSWORD to real values.
# Dev defaults will also work if you don't mind the placeholder passwords.
```

The `.env` file is gitignored. Never commit real credentials.

## 2. Install dependencies

```bash
make setup
```

This creates `.venv/` and installs Python + Node dependencies. Re-run safely
any time.

If you don't have `uv` / don't want the Makefile, manually:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pip install -e tools/cli
pip install -r services/ingestion/eln_json_importer/requirements.txt
npm install
```

## 3. Bring up the data layer

```bash
make up            # Postgres + Neo4j
make ps            # confirm both are running
```

The Postgres container auto-applies `db/init/01_schema.sql` on first boot.
Neo4j browser will be at http://localhost:7474 (log in with
`NEO4J_USER` / `NEO4J_PASSWORD` from `.env`).

To reset to a clean state (drops all volumes):

```bash
make nuke
```

## 4. Seed sample data

```bash
make db.seed
```

This creates two sample projects (`NCE-001`, `NCE-002`) and grants
`dev@local.test` admin access to both.

## 5. Import a sample ELN JSON file

```bash
source .venv/bin/activate
make import.sample
```

Expected output:

```
ok: 3 experiments, 3 reactions imported.
```

Verify in psql:

```bash
make db.psql
# Inside psql:
# \x
# SELECT internal_id, name FROM nce_projects;
# SELECT eln_entry_id, yield_pct, outcome_status FROM experiments;
# SELECT rxno_class, rxn_smiles FROM reactions;
# \q
```

## 6. Start the agent service

In a new terminal:

```bash
make run.agent
```

Visit:

- http://localhost:3100/healthz  → `{"status":"ok"}`
- http://localhost:3100/readyz   → `{"status":"ok","postgres":"up"}`
- http://localhost:3100/api/projects → list of projects visible to the dev user

## 7. Talk to the agent

The Streamlit frontend has been moved to a separate repository. For
local testing, use the CLI in `tools/cli/`:

```bash
source .venv/bin/activate
chemclaw chat "list my projects"
```

You should see a streamed response from the agent. By default the CLI
sends `x-user-entra-id: dev@local.test` (override with `CHEMCLAW_USER`).
For session continuation, use `chemclaw chat --resume "..."`. See
`tools/cli/README.md` for the full command reference and exit codes.

If you need a UI, hit the agent directly:

- `http://localhost:3101/api/projects` — list projects (set
  `x-user-entra-id` header).
- `http://localhost:3101/healthz` — liveness probe.

## 8. Tear down

```bash
make down         # stop services (volumes preserved)
# or
make nuke         # stop services AND drop volumes
```

## Troubleshooting

### Postgres container refuses to start

Check logs:

```bash
docker compose logs postgres
```

Most common cause: port 5432 already in use by a local Postgres. Either stop
that service, or change `POSTGRES_PORT` in `.env`.

### `readyz` reports `postgres: unreachable`

The agent service is in your shell — it uses `localhost:5432` by default.
If your Docker runs Postgres on a different port, make sure `POSTGRES_PORT`
in `.env` matches what `docker compose ps` shows.

### `chemclaw chat` returns 'No projects visible'

Either the schema wasn't applied, or your dev user has no
`user_project_access` entries. Run `make db.seed`, then re-run.

### Neo4j browser can't log in

Neo4j takes 30–60 seconds to start fully on first boot. Check
`docker compose logs neo4j` until you see `Started`.

## Next steps

Phase 1 (document ingestion): see the plan at
`/Users/robertmoeckel/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md`.

Phase 2 (reaction vectorization with DRFP, KG projector): upcoming.
