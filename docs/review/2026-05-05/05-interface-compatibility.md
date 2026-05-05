# A05 — Interface compatibility audit (2026-05-05)

Verified against HEAD `f1ed88e` (post #93). All claims re-grepped against current code; prior A03 stale findings have been confirmed superseded.

Scope: agent-claw ↔ MCP tool services (HTTP+JWT) and reanimator ↔ agent-claw resume route. Files inside scope listed in the orchestrator brief; no edits made outside that boundary.

## 1. postJson header set vs Python middleware expectations

**Status: PASS.** The brief overstates the header set: `services/agent-claw/src/mcp/postJson.ts` does NOT send `x-user-entra-id` — the user identity flows through the JWT `user` claim only. Outbound headers actually emitted:

- `content-type: application/json` (always)
- `Authorization: Bearer <jwt>` (when `MCP_AUTH_SIGNING_KEY` set; via `getMcpToken`)
- `x-request-id`, `x-session-id` (when `RequestContext` set; from AsyncLocalStorage)

Python middleware in `services/mcp_tools/common/app.py`:

- Reads `authorization` (case-insensitive via Starlette's `Headers`); validates `Bearer <token>` shape; rejects malformed under enforce-mode with structured `{"error":"unauthenticated","detail":...}` envelope. Probes (`/healthz`, `/readyz`) bypass.
- Reads `x-request-id` (falls back to fresh UUID); reads `x-session-id` and validates it as a UUID before binding to log context (rejects non-UUID values silently — guards against SMILES-stuffing in headers).

Error envelope is structured (`error`, `detail`) on every auth failure path, not generic 500. No fix required.

## 2. SERVICE_SCOPES parity

**Status: PASS.** Both maps have 22 identical entries.

- TS: `services/agent-claw/src/security/mcp-token-cache.ts:26-49` — 22 entries.
- Py: `services/mcp_tools/common/scopes.py:20-43` — 22 entries.
- Programmatic diff via regex extraction: identical key/value pairs, 0 diffs either direction.
- Pact: `services/mcp_tools/common/tests/test_scope_pact.py` parses the TS file, asserts equality, additionally guards against empty-scope typos. Test is intentionally fragile to TS formatting.

No fix required.

## 3. JWT claim contract

**Status: FIXED.** Cross-language signing/verification is symmetric (HS256, b64url, `sub`/`user`/`scopes`/`exp`/`iat`/`aud`). Constant-time signature compare both sides; whitespace-stripped key with ≥32-char minimum; HS256 alg pinned in the verifier.

Defect: the agent → MCP path is properly audience-bound (cycle 3 — `mcp-token-cache.ts` mints with `audience: opts.service`; Python middleware passes `expected_audience=name`). The reanimator → agent path was NOT — `session_reanimator/main.py` minted without `audience`, and `routes/sessions-handlers.ts:handleInternalResume` called `verifyBearerHeader` without `expectedAudience`. A reanimator token with scope `agent:resume` could therefore be replayed against any future endpoint that also validated `agent:resume` — small surface today, but the asymmetry violates the cycle-3 guarantee.

Fix:

- `services/optimizer/session_reanimator/main.py`: now mints with `audience="agent-claw"` (commented to keep the literal in sync with the verifier).
- `services/agent-claw/src/security/mcp-tokens.ts`: extended `verifyBearerHeader`'s opts type to accept `expectedAudience` (was already forwarded via spread to `verifyMcpToken`, only the type narrowing was missing).
- `services/agent-claw/src/routes/sessions-handlers.ts:handleInternalResume`: now calls `verifyBearerHeader(..., { requiredScope: "agent:resume", expectedAudience: "agent-claw" })`.
- `services/agent-claw/tests/integration/reanimator-roundtrip.test.ts`: updated both valid mints (and the wrong-scope mint) to carry `audience: "agent-claw"` so the audience check is satisfied while the scope assertion remains the rejecting condition.

## 4. Tool DB schema vs registry parser

**Status: DEFERRED (out of scope).** `services/agent-claw/src/tools/registry.ts:zodFromJsonSchema` only handles `string`/`number`/`boolean`/`object`/`array`. `db/seed/05_harness_tools.sql` carries 41 instances of features the parser silently downgrades to `z.unknown()`: `"type": "integer"`, `"enum"`, `"minimum"`/`"maximum"`, `"format"`, `"default"`. Examples:

- `aizynth_search.max_depth` / `max_branches` (`integer` + `minimum`/`maximum` + `default`)
- `xtb_optimize.n_conformers` (`integer`)
- `query_eln_canonical_reactions.entry_shape` / `data_quality_tier` (`string` + `enum`)
- `query_eln_canonical_reactions.limit` (`integer` + `minimum`/`maximum` + `default`)

Effect: the LLM-side tool-call schema (sent in the OpenAI tool spec) still constrains the generation, but the agent-side post-call Zod validation is weaker than the catalog claims. A model returning `n_conformers: "abc"` would not be rejected by the registry — it would land at the MCP service.

`services/agent-claw/src/tools/registry.ts` is outside A05's edit scope (owned by A04). Filed in `BACKLOG.md` under `[agent-claw/tools-registry]` with the proposed fix and test location.

## 5. Session resume contract

**Status: FIXED (covered by item 3).** With the cycle-3 audience binding now applied to this path:

- Reanimator JWT: `sub="reanimator"`, `user=<session owner>`, `scopes=["agent:resume"]`, `aud="agent-claw"`, `ttl=300s`.
- Verifier in `handleInternalResume`: `requiredScope: "agent:resume"`, `expectedAudience: "agent-claw"`. Trusts ONLY `claims.user` (not any header). `executeResume(claimedUser, ...)` is called with the JWT-derived identity — no `x-user-entra-id` forgery surface.
- Settings.assert_production_safe() in the reanimator still hard-fails at startup if `MCP_AUTH_SIGNING_KEY` is unset and `CHEMCLAW_DEV_MODE=false`.

The legacy fallback path (`/api/sessions/:id/resume` with `x-user-entra-id` header) remains for dev mode only and is gated by `chemclaw_dev_mode`.

## 6. SSE wire shapes

**Status: PASS.** Pinned shapes in `services/agent-claw/tests/parity/scenarios/*.json` use 8 event types: `session`, `text_delta`, `tool_call`, `tool_result`, `todo_update`, `awaiting_user_input`, `finish`, `hook` (with `point` discriminator). All match `services/agent-claw/src/streaming/sse-sink.ts:makeSseSink`:

- `onSession` → `{type:"session", session_id}` ✔
- `onTextDelta` → `{type:"text_delta", delta}` (redacted via `redactString`) ✔
- `onToolCall` → `{type:"tool_call", toolId, input}` ✔
- `onToolResult` → `{type:"tool_result", toolId, output}` ✔
- `onTodoUpdate` → `{type:"todo_update", todos}` ✔
- `onAwaitingUserInput` → `{type:"awaiting_user_input", session_id, question}` (redacted) ✔
- `onFinish` → `{type:"finish", finishReason, usage}` ✔

No drift; per the brief, SSE shape changes would be cross-cutting and are deferred regardless. No fix required.

## Verification

- `npx tsc --noEmit -p services/agent-claw` → clean.
- `python3 -m py_compile services/optimizer/session_reanimator/main.py services/mcp_tools/common/{scopes,auth,app}.py` → clean.
- Reanimator-roundtrip integration test mints updated to carry the new audience claim; behaviour-preserving (the test's wrong-scope rejection assertion is still the load-bearing one).

## Files edited

- `services/agent-claw/src/security/mcp-tokens.ts` (verifyBearerHeader opts type)
- `services/agent-claw/src/routes/sessions-handlers.ts` (handleInternalResume verify call)
- `services/optimizer/session_reanimator/main.py` (sign_mcp_token call)
- `services/agent-claw/tests/integration/reanimator-roundtrip.test.ts` (3 mint sites)
- `BACKLOG.md` (1 entry: tools-registry parser gap)
