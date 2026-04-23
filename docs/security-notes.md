# Security notes

## Known Dependabot findings — transitive only (as of 2026-04-23)

`npm audit` reports 33 vulnerabilities across the agent workspace. All are in
**transitive dependencies** of `@mastra/core`, the AI SDK, or dev-only tooling.
None of our direct imports are affected.

Breakdown:

| Surface | Count | Exposure to ChemClaw at runtime |
|---|---|---|
| `node-tar` / drive-relative path traversal (via Mastra deep deps) | 6 | **None** — `tar` is used at `npm install` time, not at runtime. |
| `uuid v3/v5/v6` buffer bounds (via `gaxios` → Google-telemetry path) | 1 | **None** — we use `uuidv5` WITHOUT the optional `buf` argument. |
| `fast-xml-parser` XML builder injection | 1 | **None** — we don't build XML. |
| `jsondiffpatch` HTML formatter XSS | 1 | **None** — we don't render its HTML output. |
| `vite`, `esbuild` dev-server | 2 | **Dev-only** — our containers ship compiled TS (`npm run build`), not dev servers. |
| `@ai-sdk/openai` / AI SDK file upload filetype bypass | 2 | **None** — we don't expose file-upload endpoints via AI SDK. |
| Other transitive (Mastra internals) | ~20 | Review per release. |

## Policy

1. `npm audit fix` applied where a non-breaking patch exists (none currently).
2. Each new sprint runs `npm audit` and evaluates whether new findings
   introduce actual exposure in our code paths — not just in the dep tree.
3. When a safe upgrade lands upstream, we pick it up in a dedicated commit
   and verify test + typecheck + smoke all still pass.
4. If a finding is directly exposed at runtime, it blocks the next release
   until patched or mitigated.

## What IS actively defended

- Cypher injection: double-validated regex at Pydantic + builder layers
  (see `services/mcp_tools/mcp_kg/{models,cypher}.py`)
- SQL injection: 100% parameterised queries; no string-built SQL
- ReDoS: all redactor regex patterns length-bounded; no unbounded `.*`
- Prompt injection from ingested content: bounded threat surface documented
  in `CLAUDE.md`; LiteLLM redactor strips SMILES / project IDs / emails
  pre-egress
- Rate limits: per-user on `/api/chat` (30/min), general 120/min
- Body-size caps, header length caps, request timeouts
- RLS enforced via `withUserContext` transaction-scoped `SET LOCAL`
- Non-root containers (UID 1001) on all Python service images

## What's still TODO (tracked in the plan)

- Full Langfuse tracing with PII-aware content capture policy
- NemoClaw-equivalent gVisor sandbox for code-exec pods (lands with Phase 9
  write-back)
- HashiCorp Vault integration for secrets (currently env vars only)
- SBOM generation + scanning in CI
- Pen-test before Phase 8 production gate
