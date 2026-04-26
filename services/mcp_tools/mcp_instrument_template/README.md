# Instrument MCP Adapter Template

Starting point for adding a new instrument MCP adapter (Waters Empower,
Agilent OpenLAB, Sciex Analyst, Thermo Chromeleon, or any HTTP-accessible
LIMS/CDS export). No reference adapter is currently bundled in this build,
so the steps below describe what an adapter must implement rather than
which file to copy.

## What the adapter must expose

Two endpoints, behind `services.mcp_tools.common.app.create_app(...)`:

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/run/{run_id}` | Fetch a single chromatographic run with peak data |
| `POST` | `/search_runs`  | Page over runs with filters (sample, method, date range) |

Response schemas:

- `HplcRun { id, sample_name, method_name, run_started_at, peaks: ChromatographicPeak[] }`
- `ChromatographicPeak { rt_min, area_units, height_units, name?, m_z?, ... }`

Keep these schemas stable across vendors so the agent builtin (when one is
re-introduced) doesn't have to fork per vendor.

## Steps to add a new vendor

1. Create `services/mcp_tools/mcp_instrument_<vendor>/` with `main.py`,
   `requirements.txt`, `Dockerfile`, `__init__.py`, and a `tests/` dir.

2. In `main.py`:
   - Use `create_app(name="mcp-instrument-<vendor>")` from
     `services.mcp_tools.common.app` to inherit `/healthz`, `/readyz`,
     request-ID middleware, and the standard `{error, detail}` envelope.
   - Validate every input via Pydantic. **Strict regex** on every ID path
     parameter (`^[A-Za-z0-9_\-\.]+$`) and ISO-8601 validation on
     `since` / `date_from` / `date_to` to close path-traversal /
     query-string injection on the upstream URL.
   - Implement an async client (`async with _client_factory(): ...`)
     that talks to the vendor API. Keep the route handlers free of
     vendor-specific HTTP details.

3. In `Dockerfile`:
   - Build from `python:3.11-slim`, run as UID 1001.
   - `EXPOSE` the next free port. Previously-used assignments to skip:
     8011 (admetlab — removed), 8013 (benchling — removed),
     8014 (starlims — removed), 8015 (waters — removed). Pick 8013+
     freely; just record the port in `docker-compose.yml`.

4. Add a service block under `profiles: ["sources"]` in `docker-compose.yml`
   with `security_opt: [no-new-privileges:true]` and a healthcheck against
   `/readyz`. The `kg-source-cache` projector and the `source-cache` hook
   are already wired and will pick up the new adapter automatically as
   long as its agent-claw builtin name matches
   `/^(query|fetch)_(eln|lims|instrument)_/`.

5. Register the service in `db/seed/05_harness_tools.sql`:
   - UPSERT a row in `mcp_tools` (service_name, base_url).
   - INSERT tool rows for any agent-claw builtins you add.

6. Add a builtin under `services/agent-claw/src/tools/builtins/` that wraps
   the MCP service. The builtin's tool ID must match the source-cache
   regex above so the post-tool hook fires and produces
   `source_fact_observed` ingestion events.

7. Add a section to `AGENTS.md` describing when the agent should prefer
   this adapter.

8. Write tests for the MCP service. Mock outbound HTTP at the client
   layer (`vi.stubGlobal("fetch", …)` for TS, `respx` or `httpx.MockTransport`
   for Python).

## Auth patterns by vendor

| Vendor | Typical auth | Env vars |
|---|---|---|
| Waters Empower | API key header | `WATERS_API_KEY`, `WATERS_BASE_URL` |
| Agilent OpenLAB | OAuth2 bearer token | `AGILENT_CLIENT_ID`, `AGILENT_CLIENT_SECRET`, `AGILENT_BASE_URL` |
| Sciex Analyst | Basic auth | `SCIEX_USER`, `SCIEX_PASSWORD`, `SCIEX_BASE_URL` |
| Thermo Chromeleon | Session cookie + CSRF | `THERMO_BASE_URL`, `THERMO_API_KEY` |

For OAuth2 vendors, put the token-refresh helper in a separate `auth.py`
and call it from the client factory. The route logic does not change.

## CSV-export mode

If a vendor does not expose a REST API, replace the HTTP client with a
file-system reader that parses CSV exports from a mounted volume. Keep
the same async context-manager interface (`async with _client_factory() as reader:`)
so the routes do not change.
