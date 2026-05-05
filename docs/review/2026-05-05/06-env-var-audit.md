# A06 — Env-Var Cross-Surface Audit (2026-05-05)

Reconciled env vars across 4 surfaces against `main` HEAD `f1ed88e`.
(Spec named `09d2661`; current HEAD is `f1ed88e`. Verified all findings
against the actual tree.)

## Counts at start (HEAD f1ed88e)

| Surface | Count | Source |
|---|---|---|
| TS `process.env.X` (agent-claw + paperclip) | 29 unique (incl. 4 test fixtures) | `rg "process\.env\." services --type ts` |
| Python env vars (`os.environ`/`os.getenv` + `BaseSettings` field defaults) | 89 (after dedup) | direct + pydantic-settings extraction |
| `services/agent-claw/src/config.ts` Zod schema | 68 keys | inspected `ConfigSchema` |
| `.env.example` lines | 108 keys | `grep -E '^[A-Z_]+='` |
| `docker-compose.yml` `env:` block keys | 84 unique | per-service env: blocks |
| `infra/helm/values.yaml` chemclaw-image services | 43 chemclaw services | counted |

## Drift before fix

### `.env.example` → source: documented but no consumer

Verified by intersecting with TS sources, all `BaseSettings` subclasses
(including transitively via `ToolSettings`), `docker-compose.yml`,
`infra/helm/`, and `services/litellm/config.yaml`.

Truly dead (no consumer anywhere):

- `LITELLM_HOST`, `LITELLM_PORT` — superseded by `LITELLM_BASE_URL`
- `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`,
  `OAUTH2_PROXY_COOKIE_SECRET` — identity placeholders, never wired
- `CHEMCLAW_DEV_USER_PROJECTS` — unused (dev-mode user only honours email)
- `AGENT_USER_HEADER` — only README mentions; reanimator never reads
- `BENCHLING_API_KEY`, `BENCHLING_BASE_URL`, `STARLIMS_USER`,
  `STARLIMS_TOKEN`, `STARLIMS_BASE_URL`, `WATERS_API_KEY`,
  `EMPOWER_BASE_URL` — vendor adapters retired in Phase F.2 (see
  CLAUDE.md §F.2: `eln_json_importer` → legacy)
- `ELN_JSON_DROP_FOLDER` — `eln_json_importer` retired
- `SMB_DOCUMENTS_ROOT` — never read; `doc-ingester` uses `DOCS_ROOT`

13 dead lines total.

### Source → `.env.example`: read but undocumented

Filtered to vars worth documenting (excluded test fixtures
`AGENT_FOO_BAR`/`MY_FEATURE_FLAG`/`NEVER_SET`/`SOMETHING_ELSE`,
internal model-dir defaults like `ASKCOS_MODEL_DIR` consumed inside
their service container only):

- `AGENT_MODEL` — model alias, in config.ts default
- `LITELLM_API_KEY`, `LITELLM_BASE_URL` — Python tools (gepa_runner,
  mcp_synthegy_mech) and agent-claw both read these
- `DB_SLOW_TXN_MS` — `db/with-user-context.ts`
- `OTEL_EXPORTER_OTLP_ENDPOINT` — `observability/otel.ts`
- `SANDBOX_MAX_CPU_S`, `SANDBOX_MAX_NET_EGRESS` — `core/sandbox.ts`
- `MCP_DOC_FETCHER_FILE_ROOTS` — `mcp_doc_fetcher/validators.py`,
  security-sensitive file:// allowlist
- `MOCK_ELN_DSN`, `MOCK_ELN_ENABLED`, `MOCK_ELN_ALLOW_DEV_PASSWORD`
  — testbed mock ELN
- `LOGS_ALLOW_DEV_PASSWORD` — sources mcp-logs-sciy

### config.ts ↔ source

8 production env vars referenced via `process.env.X` in agent-claw
src but absent from the Zod `ConfigSchema`:

| Var | Source file |
|---|---|
| `AGENT_ADMIN_USERS` | `middleware/require-admin.ts` |
| `DB_SLOW_TXN_MS` | `db/with-user-context.ts` |
| `LOG_USER_SALT` | `observability/user-hash.ts` |
| `MCP_AUTH_SIGNING_KEY` | `security/mcp-tokens.ts`, `mcp-token-cache.ts` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `observability/otel.ts` |
| `SANDBOX_ALLOW_NET_EGRESS` | `core/sandbox.ts` |
| `SANDBOX_MAX_CPU_S` | `core/sandbox.ts` |
| `SANDBOX_MAX_NET_EGRESS` | `core/sandbox.ts` |

### Compose env: ↔ source

Zero phantom env keys. Vars that initially looked unreferenced
(`MCP_TABICL_ADMIN_TOKEN`, `LOGS_BACKEND`, `DOCS_ROOT`, `HF_HOME`,
all `LANGFUSE_INIT_*`, `GF_*`, `CLICKHOUSE_*`, `NEO4J_AUTH`,
`NEO4J_PLUGINS`, `POSTGRES_INITDB_ARGS`, `NEXTAUTH_*`,
`TELEMETRY_ENABLED`, `ENCRYPTION_KEY`, `DATABASE_URL`,
`GEPA_GOLDEN_FIXTURE`) are all consumed either by third-party
container images or by service-internal aliased-Field reads (e.g.
`alias="MCP_TABICL_ADMIN_TOKEN"` in `mcp_tabicl/main.py`).

### Helm values.yaml ↔ compose

Each `chemclaw/*:latest` image in `values.yaml` has a matching
compose `build:` block. The reverse holds modulo the known
divergence that `agent-claw`, `litellm`, `litellm-redactor`, and
`paperclip-lite` are not in `docker-compose.yml` (run via
`make run.agent` / external launches) — they are templated in
helm. `doc-ingester` is in compose but absent from helm; out of
scope (deferred — only ingestion path that is local-only).

## Fixes applied

### `services/agent-claw/src/config.ts`

Added 8 entries to `ConfigSchema`:

- `AGENT_ADMIN_USERS: z.string().default("")`
- `LOG_USER_SALT: z.string().default("")`
- `MCP_AUTH_SIGNING_KEY: z.string().default("")`
- `OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional()`
- `DB_SLOW_TXN_MS: z.coerce.number().int().nonnegative().default(200)`
- `SANDBOX_MAX_CPU_S: z.coerce.number().int().positive().default(30)`
- `SANDBOX_ALLOW_NET_EGRESS` and `SANDBOX_MAX_NET_EGRESS` —
  string→bool transforms (default false)

Existing modules continue reading via `process.env.X` (minimum
code), but the schema now validates these at startup and serves as
the canonical default registry.

Schema key count: 68 → 76.

### `.env.example`

Removed 13 dead lines:
`LITELLM_HOST`, `LITELLM_PORT`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`,
`ENTRA_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`,
`CHEMCLAW_DEV_USER_PROJECTS`, `AGENT_USER_HEADER`,
`BENCHLING_API_KEY`, `BENCHLING_BASE_URL`, `STARLIMS_USER`,
`STARLIMS_TOKEN`, `STARLIMS_BASE_URL`, `WATERS_API_KEY`,
`EMPOWER_BASE_URL`, `ELN_JSON_DROP_FOLDER`, `SMB_DOCUMENTS_ROOT`.

Added with sensible defaults / inline comments:
`AGENT_MODEL`, `LITELLM_API_KEY`, `LITELLM_BASE_URL`,
`DB_SLOW_TXN_MS`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`SANDBOX_MAX_CPU_S`, `SANDBOX_MAX_NET_EGRESS`,
`MCP_DOC_FETCHER_FILE_ROOTS`, `MOCK_ELN_DSN`, `MOCK_ELN_ENABLED`,
`MOCK_ELN_ALLOW_DEV_PASSWORD`, `LOGS_ALLOW_DEV_PASSWORD`.

Net: 108 → 103 lines, with vendor / identity cruft replaced by
correctly-aligned production knobs.

### `docker-compose.yml` and `infra/helm/`

No edits. Both surfaces were clean against current source.

## Verification

```
$ cd services/agent-claw && npx tsc --noEmit
(exit 0, clean)
```

`grep -E "^[A-Z_]+=" .env.example | wc -l` → 103
`grep -E "^\s+[A-Z_]+:" services/agent-claw/src/config.ts | wc -l` → 76

## Stale-claim verification

Per A03 / 2026-05-04 audit:

- DRIFT-D (`MCP_ELN_BENCHLING_URL`/`MCP_LIMS_STARLIMS_URL`/
  `MCP_INSTRUMENT_WATERS_URL` phantom) — **already fixed**, those
  vars are not in `.env.example` at HEAD `f1ed88e`. Not re-flagged.
- M10 (`MCP_AUTH_SIGNING_KEY` missing on `mcp-eln-local`/
  `mcp-logs-sciy`) — **already fixed** at HEAD; both blocks set
  `MCP_AUTH_SIGNINGKEY: ${MCP_AUTH_SIGNING_KEY:-}` with comments.
  Not re-flagged.

## Deferred

- **Refactor `process.env.X` → `cfg.X`** in `core/sandbox.ts`,
  `db/with-user-context.ts`, `middleware/require-admin.ts`,
  `observability/{user-hash,otel}.ts`, `security/mcp-tokens.ts`.
  Pure mechanical rewrite; behaviour identical. Out of scope (more
  than minimum code for an env-var audit).
- **Helm templating for `doc-ingester`** — currently compose-only;
  no helm chart entry. Defer until ingestion is actually deployed
  to a cluster.
- **Schema-validated config across Python services** —
  `LITELLM_BASE_URL` / `LITELLM_API_KEY` are read with raw
  `os.environ.get` in `optimizer/gepa_runner/runner.py` and
  `mcp_tools/mcp_synthegy_mech/llm_policy.py`. Could move to a
  shared pydantic settings class. Defer.
- **Helm secret refs vs literal env** — compose currently passes
  `LANGFUSE_*`, `MCP_AUTH_SIGNING_KEY`, `LITELLM_MASTER_KEY` as
  literal env vars from `.env`. Production should mount these via
  Kubernetes Secrets. Helm has the scaffolding (`logUserSalt.secretName`,
  `mcpAuth.signingKeySecret`) but most chemistry/projector deployments
  inline literals. Out of scope per mission ("defer secret-handling
  improvements").
- **Add `AGENT_MODEL` to compose env: blocks** for services that
  shadow-evaluate (only agent-claw uses it; agent-claw isn't in
  compose). No-op until agent-claw enters compose.

## Files touched

- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/.env.example`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/agent-claw/src/config.ts`
