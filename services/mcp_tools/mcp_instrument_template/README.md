# Instrument MCP Adapter Template

Use `mcp_instrument_waters` as the canonical reference to fork a new vendor adapter
in under a day. The pattern is the same for Agilent OpenLAB, Sciex Analyst, Thermo
Chromeleon, or any HTTP-accessible LIMS/CDS export.

## Steps to fork

1. Copy `services/mcp_tools/mcp_instrument_waters/` to `services/mcp_tools/mcp_instrument_<vendor>/`.

2. Update `main.py`:
   - Change the module docstring, logger name (`mcp-instrument-<vendor>`), and `create_app(name=...)`.
   - Replace `_WATERS_API_KEY` / `_WATERS_BASE_URL` with vendor-specific env vars.
   - Update `_make_client()` — swap header names and base URL pattern as needed.
   - Adjust `_parse_run()` / `_parse_peak()` to match the vendor's JSON shape.
   - Keep `HplcRun` / `ChromatographicPeak` schemas **unchanged** so the agent builtin
     `fetch_instrument_run` / `query_instrument_runs` does not need modification.

3. Update `Dockerfile`:
   - Change the `COPY` path and the `CMD` module path to match the new package name.
   - Change `EXPOSE` to the next free port (current assignments: Waters=8015, add 8016, 8017, …).

4. Add the service to `docker-compose.yml` under `profiles: ["sources"]` (copy the `mcp-instrument-waters` block and update name/port/build path).

5. Register the new service in `db/seed/05_harness_tools.sql` — UPSERT a row in `mcp_tools` and tool rows for `fetch_instrument_run_<vendor>` / `query_instrument_runs_<vendor>`.

6. Add a AGENTS.md entry in the "Source systems" section so the agent knows when to prefer the new adapter.

7. Write tests by copying `tests/test_mcp_instrument_waters.py` and updating mock payloads for the vendor's field names.

## Auth patterns by vendor

| Vendor | Typical auth | Env vars |
|---|---|---|
| Waters Empower | API key header | `WATERS_API_KEY`, `WATERS_BASE_URL` |
| Agilent OpenLAB | OAuth2 bearer token | `AGILENT_CLIENT_ID`, `AGILENT_CLIENT_SECRET`, `AGILENT_BASE_URL` |
| Sciex Analyst | Basic auth | `SCIEX_USER`, `SCIEX_PASSWORD`, `SCIEX_BASE_URL` |
| Thermo Chromeleon | Session cookie + CSRF | `THERMO_BASE_URL`, `THERMO_API_KEY` |

For OAuth2 vendors, add a token-refresh helper in a separate `auth.py` file and
call it from `_make_client()`. The route logic does not change.

## CSV-export mode

If the vendor does not expose a REST API, `_make_client()` can be replaced by a
file-system reader that parses CSV exports from a mounted volume. Keep the same
async context-manager interface (`async with _client_factory() as reader:`); the
routes stay identical. See `mcp_instrument_waters` for the shape the routes expect.
