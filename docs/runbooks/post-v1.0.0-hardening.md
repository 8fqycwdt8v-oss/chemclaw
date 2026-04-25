# Post-v1.0.0-claw hardening — what shipped, what didn't

Branch `fix/post-v1.0.0-hardening` is the result of a full multi-agent
audit of v1.0.0-claw. Four parallel reviewers (security, harness review,
projector review, refactor review) identified ~32 distinct findings.
This branch ships the high-confidence fixes; the remainder are listed
at the bottom with notes for follow-up.

## Test coverage of the change set

```
services/agent-claw/  npm test       637 / 637 ✓ (was 634; 3 added for redact-secrets)
services/agent-claw/  npx tsc --noEmit  ok
tests/unit/test_redactor.py            7 /  7 ✓
services/mcp_tools/mcp_eln_benchling/tests/      ✓
services/mcp_tools/mcp_lims_starlims/tests/      ✓
services/mcp_tools/mcp_instrument_waters/tests/  ✓
services/projectors/kg_source_cache/tests/       ✓     (35 / 35 across the four)
```

## What shipped (P0 + P1 — substantive security and correctness)

### Harness (`services/agent-claw/`)

- `redact-secrets` hook rewired from `pre_tool` to `post_turn`. The old
  registration silently mangled tool inputs (SMILES → `[REDACTED]`
  before chemistry tools saw them) AND failed to scrub the assistant's
  outbound text. Each `text_delta` is now scrubbed in flight via
  `redactString` plus a final `post_turn` pass. Hook now registered
  in the sub-agent lifecycle too. (`fix/post-v1.0.0-hardening` 3695d70)
- SSE chat route's `post_turn` dispatch and `finish` event moved into a
  `finally` block — mirrors `runHarness()`. Errors no longer skip the
  redact pass or audit hooks. (3695d70)
- Production auth fallback removed: missing `x-user-entra-id` in non-dev
  mode now returns 401 (was: silently treated as `dev@local.test`).
  (cff31d6)
- `Lifecycle.dispatch` now log-and-continues on non-pre_tool hook
  errors so a transient `tag-maturity` DB hiccup doesn't suppress the
  later `redact-secrets` post_turn pass. `pre_tool` retains strict-throw.
  (030883b)
- Optimizer routes `/api/optimizer/*` now require `admin` role on any
  project — previously open. (030883b)
- `ToolRegistry.loadFromDb` skips DB rows that would overwrite a
  programmatically-registered builtin. Documents precedence
  (in-memory builtin > DB row). (030883b)
- `fetch_eln_entry`, `fetch_lims_result`, `fetch_instrument_run`:
  replaced `as FetchXxxOutput` casts with Zod parse via a new typed
  `getJson` helper. (3695d70)
- `SANDBOX_MAX_NET_EGRESS` → `SANDBOX_ALLOW_NET_EGRESS` (canonical name;
  old read as fallback for migration). (030883b)

### Database / RLS (`db/init/12_security_hardening.sql`)

- `FORCE ROW LEVEL SECURITY` on every RLS-enabled table. Without this,
  table owners (which the agent connects as) trivially bypass every
  policy — meaning RLS was vacuous in v1.0.0-claw. (cff31d6)
- New `chemclaw_app` role (LOGIN, NO BYPASSRLS) for app traffic.
- `chemclaw_service` promoted from NOLOGIN to LOGIN BYPASSRLS.
  Projectors now use it without the kg-hypotheses boot failure.
- RLS policies added to `documents`, `document_chunks`, `compounds`,
  `reactions`, `feedback_events`, `corrections`, `notifications`,
  `prompt_registry`. Per-user scoping where the schema allows; require
  authenticated user for the rest.
- `document_chunks.byte_start` / `byte_end` columns added so the
  `contextual_chunker` projector stops crashing on every event.

### MCP services

- `mcp_doc_fetcher`: SSRF allowlist (`MCP_DOC_FETCHER_ALLOW_HOSTS`);
  private/loopback/link-local IP block enforced on every redirect hop;
  manual redirect walking with full re-validation; cap of 5 redirects.
  (cff31d6)
- `mcp_eln_benchling`, `mcp_lims_starlims`, `mcp_instrument_waters`:
  strict regex on every ID Path field (`^[A-Za-z0-9_\-\.]+$`),
  ISO-8601 validation on every `since`/`date_from`/`date_to`. Closes
  the path-traversal / query-string injection surface that fed
  attacker-supplied fragments into upstream URLs. (cff31d6)
- `mcp_kg`: migrated to `create_app(...)` for free request-ID
  middleware and the standardized `{error, detail}` envelope. (3695d70)
- `services/mcp_tools/common/app.py`: standard `HTTPException` handler
  produces `{error, detail}` for every status code. (3695d70)

### Projectors

- `BaseProjector.run()` now reconnects with exponential backoff on
  transient DB drops. Previously a Postgres blip killed the process. (030883b)
- `contextual_chunker` retry-storm bug fixed: empty-string sentinel for
  permanently-failed chunks is preserved (was being converted to NULL). (3695d70)

### Cross-service

- `litellm_redactor`: `redact_messages` now scrubs assistant
  `tool_calls[].function.arguments`. Previously only `content` was
  scrubbed, leaking SMILES/NCE/CMP via tool-call argument strings. (030883b)
- Cross-service version constraints file (`services/_constraints.txt`).
  `mcp_tabicl` migrated from unmaintained `rdkit-pypi 2022.9.5` to
  `rdkit` (active fork) so canonicalization matches the rest of the
  fleet — fixes potential duplicate `:Compound` nodes in the KG.
  `forged_tool_validator` migrated from `psycopg2-binary` to `psycopg3`. (030883b)

### Documentation

- `docs/adr/006-sandbox-isolation.md`: target-state design for E2B
  network namespace lockdown + MCP service authentication, plus
  interim mitigations. Implementation deferred — see "Deferred" below.

## Deferred (deliberate; reasoning included)

| Audit item | Why deferred | Tracking |
|---|---|---|
| W2.10 `withUserContext` on every user-reachable `pool.query` site | Today every connection runs as the table owner so RLS is bypassed regardless. After the chemclaw_app migration is staged across `docker-compose.yml` for every service (out of scope for one PR — touches ~20 services), each `pool.query` site needs auditing. The migration file is in place; the connection-string changes per service are separate. | Open: docker-compose service-by-service migration to `chemclaw_app` |
| W2.15 Forged-tool SHA-256 verification | Belt-and-suspenders against on-disk tampering of forged Python. The actual remote-execution boundary is the E2B sandbox, which ADR 006 addresses more directly. Layering the hash check makes more sense after the sandbox isolation lands so we know the threat model. | Open after ADR 006 implementation |
| W2.17 Builtin tool factory wiring | The 30 `build*Tool(...)` factories in `src/tools/builtins/` (with handcrafted Zod schemas + citation enrichment) are dead in production: only `canonicalize_smiles` is registered in `index.ts`; everything else resolves through the generic `source='mcp'` path with `z.unknown()` validation. Two valid paths: (a) wire all factories like `canonicalize_smiles`, or (b) move citation enrichment to the post_tool `source-cache` hook and delete the factories. The decision belongs to the citation-pipeline owner, not an automated audit. | Open — needs design decision |
| W2.3 Remove empty-user RLS fall-through in `01_schema.sql` | Removing today would break every service still connecting as the owner role with no `set_config(...)`. Empty-user permissive branches stay until the chemclaw_app migration is complete. | Bundled with W2.10 |
| Sandbox isolation (ADR 006 implementation) | Multi-week engineering: custom E2B template + iptables firewall + per-sandbox JWT mint + MCP auth middleware + RPC-bridge for sandbox→agent tool calls. Until landed: keep `SANDBOX_ALLOW_NET_EGRESS=false` in shared environments. | `docs/adr/006-sandbox-isolation.md` |
| 16 GitHub Dependabot vulnerabilities | A separate `gh api repos/.../dependabot/alerts` call was blocked by a Bash permission rule during the audit. List needs to be fetched from the GitHub Security tab (manual) and triaged against the new `services/_constraints.txt`. | Open — needs `gh api` permission or manual run |

## Migration / rollout notes

- `db/init/12_security_hardening.sql` is idempotent. Re-running on an
  existing database adds the new columns and policies without data
  loss. New roles (`chemclaw_app`, `chemclaw_service` LOGIN promotion)
  use the dev placeholder password if not overridden — production
  must set `chemclaw.app_password` and `chemclaw.service_password`
  via `ALTER SYSTEM SET` or override before applying.
- `kg-hypotheses` will now boot — previously failing with
  `FATAL: role "chemclaw_service" is not permitted to log in`.
- Existing connections as `chemclaw` (the owner) keep working for
  migrations and for any service that hasn't yet been switched to
  `chemclaw_app`. They DO become subject to FORCE RLS, so any
  service connecting as `chemclaw` AND not setting
  `app.current_user_entra_id` AND reading from one of the FORCE'd
  tables WILL see zero rows. This is intentional — fail-closed —
  but make sure your service either:
    1. Switches to `chemclaw_app` and sets a real user context, or
    2. Switches to `chemclaw_service` (BYPASSRLS) for system workloads.

## Reviewing this branch

Suggested reading order:
1. `db/init/12_security_hardening.sql` — the largest blast radius; read first.
2. `services/agent-claw/src/core/hooks/redact-secrets.ts` + chat.ts diff.
3. `docs/adr/006-sandbox-isolation.md` for the next major work item.
4. The MCP / source-adapter diffs for the SSRF + ID-validation work.

Each commit is a logical unit and `git log --oneline` reads as a
narrative.
