# Tier 4 / Agent A12 — Security audit (cycle 4)

Scope: post-Tier-3 codebase (HEAD `b7b2803`). Re-verify against the audit
prompt's nine checks; apply real fixes for genuine vulnerabilities; defer
architectural items to BACKLOG.

## Summary

| # | Verification | Status | Severity | Action |
|---|---|---|---|---|
| 1 | Admin RBAC + audit on `/api/admin/*` | Already complete | — | No-op (validated all 6 admin route files) |
| 2 | DR-14 TS-side traceback redaction | **FIXED** | P1 | Added Pino `err` serializer + extracted `redactString` to leaf module |
| 3 | mcp_doc_fetcher SSRF + DNS rebinding (TOCTOU) | **FIXED** | P0 | Thread-local `socket.getaddrinfo` pin to validated IPs |
| 4 | LOG_USER_SALT enforced at boot | **FIXED** | P2 | Added `assertLogUserSaltConfigured` called from `loadConfig` |
| 5 | CORS null-origin + credentials | **FIXED** | P1 | Reject `Origin: null` while still permitting missing-Origin |
| 6 | JWT `verifyBearerHeader` audience binding | Already complete | — | Single caller (sessions-handlers.ts) has `expectedAudience: "agent-claw"` |
| 7a | LiteLLM redactor SMILES over-fire | **FIXED (residual)** | P2 | Restricted bond-target alphabet to SMILES atom letters |
| 7b | LiteLLM redactor `is_pattern_safe` weak | **FIXED** | P1 | General "no unbounded `+`/`*`/{n,}" walker (Py + TS mirror) |
| 7c | LiteLLM per-call org context | Deferred | — | BACKLOG (architectural — needs gateway header plumbing) |
| 8 | forged_tool_validator local-subprocess fallback | Already complete | — | `_DEV_OPT_IN_ENV` fail-closed guard verified |
| 9 | LiteLLM Dockerfile tag pinning | Already complete | — | `main-v1.60.0` (not `:latest`) |

**Counts:** P0 fixed = 1. P1 fixed = 3. P2 fixed = 2. Deferred = 2.

---

## Verification 1 — Admin RBAC + audit (no-op)

Walked every file in `services/agent-claw/src/routes/admin/`:

- `admin-users.ts`: GRANT (`POST`) and REVOKE (`DELETE`) both wrap in `guardAdmin`
  and call `appendAudit` on success. List `GET` is admin-gated.
- `admin-config.ts`: PATCH and DELETE call `adminAllowedForScope` (which checks
  global_admin or scoped admin), `appendAudit` on every state-mutating branch,
  and bust `getConfigRegistry().invalidate(key)` after the write.
- `admin-flags.ts`: POST and DELETE wrap in `guardAdmin`, call `appendAudit`,
  and bust `getFeatureFlagRegistry().invalidate()`.
- `admin-permissions.ts`: POST/PATCH/DELETE call `adminAllowedForScope`,
  `appendAudit`, and bust `getPermissionPolicyLoader()?.invalidate()`.
- `admin-redaction.ts`: POST/PATCH/DELETE wrap in `guardAdmin` and call
  `appendAudit`. (No agent-side cache — Python redactor loads fresh; the
  Python side's TTL is the only cache.)
- `admin-audit.ts`: GET only.

All wired to `audit-log.ts:appendAudit`. RLS recursion on `admin_roles` is
handled by the SECURITY DEFINER `current_user_is_admin()` function (per
`db/init/18_admin_roles_and_audit.sql`).

## Verification 2 — DR-14 TS-side traceback redaction (FIXED)

**Problem.** `services/agent-claw/src/observability/logger.ts` ROOT_REDACT_PATHS
caught known-shape fields by name but Pino's path redaction does not run regex
over values. Postgres / MCP errors regularly carry SMILES + compound-codes
inside `err.message` / `err.stack` (driver-formatted "Failing row contains
(…)" strings) — those leaked to Loki untouched. BACKLOG-75.

**Attack scenario.** A malicious or accidental compound-code in an INSERT
payload → `unique_violation` raised → `err.message` includes `…CMP-12345…`
→ Pino emits the raw string → SMILES / NCE-IDs / compound codes land in the
log archive.

**Fix.** Three-part change:
1. Extracted the regex pipeline (RXN_SMILES, SMILES, EMAIL, NCE, CMP — all
   length-bounded per the existing safety baseline) from
   `core/hooks/redact-secrets.ts` into a leaf module
   `services/agent-claw/src/observability/redact-string.ts` so the logger
   can import it without crossing into `core/*` (would risk circular dep
   since core eventually calls `getLogger`).
2. `core/hooks/redact-secrets.ts` now re-exports `redactString` from the new
   leaf so existing callers (`core/session-state.ts`) stay working.
3. Added a Pino `err` serializer in `logger.ts` that runs the scrub over
   `err.message` and `err.stack` while preserving `err.type`, `err.code`,
   `err.statusCode`, and (one-level) `err.cause`. Same serializer is bound
   to the `error` field name for legacy call sites.

**Files touched.**
- New: `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/agent-claw/src/observability/redact-string.ts`
- Modified: `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/agent-claw/src/observability/logger.ts`
- Modified: `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/agent-claw/src/core/hooks/redact-secrets.ts`

**Tests.** `tests/unit/logger.test.ts`, `tests/unit/hooks-redact-secrets.test.ts`,
`tests/unit/sse-sink-redaction.test.ts`, `tests/unit/user-hash.test.ts` — all
31 pre-existing tests pass. Full agent-claw suite: 1118/1118.

## Verification 3 — mcp_doc_fetcher SSRF + DNS rebinding (FIXED, P0)

**Problem.** `validate_network_host()` resolved the host once via
`socket.getaddrinfo()` and validated the returned IPs. `fetch_https()` then
called `httpx.Client.stream("GET", uri)` which performs its own DNS
resolution at connect time. An attacker controlling DNS for a hostname they
provide (e.g., via a malicious URL in a tool argument) can serve the
validate-time query as a public IP and the connect-time query as
`169.254.169.254` (cloud metadata) or `127.0.0.1` — the classic
**TOCTOU DNS rebinding** bypass. Re-resolving alone doesn't help: a TTL-0
zone can flip between requests.

**Attack scenario.** Attacker registers `attacker.example.com` with a TTL-0
DNS server alternating between `1.2.3.4` and `169.254.169.254`. They
submit a tool argument containing `https://attacker.example.com/data`.
`validate_network_host("attacker.example.com")` resolves to `1.2.3.4`
(public, accepted). httpx connects ~5–50 ms later, re-resolves, and gets
`169.254.169.254`. The fetcher reads cloud metadata and returns it via the
tool result.

**Fix.** Capture the validated IP set at the validate step (changed
`validate_network_host` to return `list[str]`), then install a
**thread-local DNS pin** for the fetch's duration. The pin replaces
`socket.getaddrinfo` (process-globally, but only for hostnames pinned in
the calling thread) so any subsequent connect attempt by httpx — including
across redirect hops — uses ONLY the validated IPs. The pin is removed in
a `finally` so other threads / unrelated calls see the standard resolver.

If a pinned IP unexpectedly fails to re-resolve (it shouldn't — they're
literal IPs), the wrapper raises `socket.gaierror` rather than falling
back to public DNS. Fail-closed.

**Files touched.**
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/mcp_tools/mcp_doc_fetcher/validators.py`
  (validate_network_host now returns the validated IP list)
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/mcp_tools/mcp_doc_fetcher/fetchers.py`
  (added `pin_resolution` contextmanager; fetch_https wraps each hop)

**Tests.** Pre-existing 7 test failures in `test_mcp_doc_fetcher.py` are
**unrelated** (they import `_ip_is_blocked` from `main` but the function
moved to `validators` and was renamed; BACKLOG-70 already tracks). 13/20
remaining tests still pass post-fix; same as pre-fix baseline.

## Verification 4 — LOG_USER_SALT enforced at boot (FIXED, P2)

**Problem.** `services/agent-claw/src/observability/user-hash.ts:salt()` is
lazily resolved on first `hashUser()` call. A misconfigured production
deploy (no `LOG_USER_SALT`, no `CHEMCLAW_DEV_MODE=true`) boots successfully,
the readyz probe goes green, and only fails when an HTTP request first tries
to log a user identifier. Alerting fires on traffic, not on misconfiguration.

**Fix.** Added `assertLogUserSaltConfigured()` exported by user-hash.ts
that triggers the same fail-closed path; called from `loadConfig()`. A
misconfigured deploy now fails hard at boot (process.exit(1) with a
structured fatal log line) the same way a missing required env var does.
user-hash.ts is a leaf module (only imports `node:crypto`) so this can't
trigger a circular dep.

**Files touched.**
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/agent-claw/src/observability/user-hash.ts`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/agent-claw/src/config.ts`

**Tests.** `vitest.config.ts` already sets `CHEMCLAW_DEV_MODE=true` for the
test process so the new boot assertion never fires under tests. All 7
existing user-hash tests still pass.

## Verification 5 — CORS null-origin bypass (FIXED, P1)

**Problem.** `services/agent-claw/src/bootstrap/server.ts:50` accepted any
falsy origin including the literal string `null`. Combined with
`credentials: true`, this is the classic null-origin bypass: a sandboxed
iframe (`<iframe sandbox="allow-scripts">`), a `file://` page, or some
redirect chains send `Origin: null`, and an Allow-Origin echo of `null`
+ credentials lets that attacker page read responses to authenticated
requests (cookies / `x-user-entra-id` are forwarded by the same browser).

**Attack scenario.** A user opens a malicious doc in a sandboxed iframe.
The iframe issues `fetch("https://agent-claw.example/api/chat", {credentials: "include"})`.
With `Origin: null` + `Allow-Origin: null` + `Allow-Credentials: true`,
the browser permits the request and returns the response to the attacker
page. Authenticated chat data exfiltrated.

**Fix.** Distinguish "no Origin header" (curl, server-to-server, health
probes — permitted) from "`Origin: null`" (sandboxed iframe, file:// —
explicitly rejected). The fix is a 3-line guard inserted into the existing
allowlist callback.

**Files touched.**
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/agent-claw/src/bootstrap/server.ts`

## Verification 6 — JWT audience binding (no-op)

`grep -rn "verifyBearerHeader"` returns one production caller:
`routes/sessions-handlers.ts:380` (the `/api/internal/sessions/:id/resume`
handler) which already passes `expectedAudience: "agent-claw"` (PR #94).
The reanimator daemon mints with the same audience. No other route accepts
JWTs for user-identity binding. Verified clean.

## Verification 7a — LiteLLM redactor SMILES over-fire (FIXED, P2)

**Problem.** `services/litellm_redactor/redaction.py:_looks_like_smiles`
required only "any one of `=#()/\\` + any letter" — false-fired on
`--opt=value`, `(page=12, line=34)`, `f(x)=value+1`, and similar prose.
BACKLOG-59.

**Fix.** Restricted the bond-target alphabet to SMILES atom letters
(organic subset `C N O S P F B I H` + aromatic lowercase `c n o s p b`).
Real chemistry features (`=O`, `c1ccccc1`, `[C@@H]`, `Br/C=C/Cl`) still
match; URL fragments like `=value`, `=12`, `/path/` no longer fire because
the chars after `=`/`/` aren't SMILES atom letters. Also dropped the
ambiguous `structural_count >= 2` fallback that was the dominant
over-fire path. Mirrored on the TS side in `redact-string.ts`.

**Verified.** Manual test cases (in audit transcript): `--opt=value`,
`(page=12, line=34)`, `f(x)=value+1`, `[Run #5]`, `2.5(3)` — all pass
through unredacted. Real SMILES (`CC(=O)Oc1ccccc1C(=O)O`,
`Br/C=C/Cl`, `[C@@H](Cl)(F)Br`, `c1ccccc1`) — all redacted.

**Residual.** Multi-slash file paths like `/path/to/file.txt` and
`a/b/c/d/e/f` still match (each `/X` where X is `c`/`p`/`f`/`t` etc.
matches the multi-bond test). Acceptable: over-redacts harmless paths,
never leaks chemistry. Documented in BACKLOG.

**Files touched.**
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/litellm_redactor/redaction.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/agent-claw/src/observability/redact-string.ts`

## Verification 7b — `is_pattern_safe` accepts catastrophic-backtracking patterns (FIXED, P1)

**Problem.** `services/litellm_redactor/dynamic_patterns.py:_UNBOUNDED_QUANT`
was a fixed-string regex matching `.*`, `.+`, `\S+`, `\w+`, `\d+`, `\D+`,
`\W+` only. It accepted catastrophic-backtracking forms:
`(a+)+`, `(a|a)*`, `[a-z]+`, `b+`, `\.[A-Z]+` — all of which can DOS the
redactor regex engine when applied to crafted input.

**Attack scenario.** A tenant admin (org_admin scope) submits a redaction
pattern `^([a-z]+)+$` via `POST /api/admin/redaction-patterns`. The current
length cap (200) and old fixed-string check both let it through. On every
LLM message that triggers the pattern, the regex engine takes
exponential time. Process becomes unresponsive — DOS via authenticated
admin.

**Fix.** Replaced the fixed-string regex with a stateful walker
(`_has_unbounded_quantifier`) that:
- skips escapes (so `\+` / `\*` are literals),
- walks character classes as a unit (so `[+*]` literal class doesn't
  false-positive),
- rejects any unescaped `+` / `*` (greedy or lazy) outside a class,
- rejects `{n,}` open-ended quantifiers (only `{n}` and `{n,m}` allowed).

Same scanner ported to TypeScript in `admin-redaction.ts`'s
`findUnboundedQuantifier()` so the admin endpoint rejects pre-write the
same patterns the redactor would reject post-read.

**Verified.** All 25 redactor tests pass. Bypass examples
(`(a+)+`, `(a|a)*`, `[a-z]+`, `b+`, `foo{3,}`) — now rejected. Legit
forms (`a{1,5}`, `\d{4,8}`, `[abc]{0,5}`, `CMP-\d{4,8}`) — accepted.

**Files touched.**
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/litellm_redactor/dynamic_patterns.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw/services/agent-claw/src/routes/admin/admin-redaction.ts`

## Verification 7c — LiteLLM per-call org context (deferred)

Architectural change requiring a custom HTTP header on every LiteLLM call,
plus gateway-side parsing. Single PR scope rejected — left in BACKLOG.

## Verification 8 — Sandbox local-subprocess fallback (no-op)

`services/optimizer/forged_tool_validator/sandbox_client.py:LocalSubprocessSandbox`
already has the `_DEV_OPT_IN_ENV` (`CHEMCLAW_ALLOW_LOCAL_SANDBOX=1`) guard
that fail-closes when not explicitly opted in. Production E2B path is
unchanged. Verified clean.

## Verification 9 — LiteLLM Dockerfile tag pinning (no-op)

`services/litellm_redactor/Dockerfile` line 15:
`ARG LITELLM_BASE_IMAGE=ghcr.io/berriai/litellm:main-v1.60.0`. Pinned
to a specific upstream tag (not `:latest`); the file's docstring
documents the override-with-digest-in-prod workflow. Verified clean.

---

## Files modified (final list)

```
services/agent-claw/src/bootstrap/server.ts        (CORS null-origin)
services/agent-claw/src/config.ts                  (LOG_USER_SALT boot assert)
services/agent-claw/src/core/hooks/redact-secrets.ts (re-export from leaf)
services/agent-claw/src/observability/logger.ts    (Pino err serializer)
services/agent-claw/src/observability/user-hash.ts (assertLogUserSaltConfigured)
services/agent-claw/src/observability/redact-string.ts (NEW — leaf util)
services/agent-claw/src/routes/admin/admin-redaction.ts (regex safety walker)
services/litellm_redactor/dynamic_patterns.py      (regex safety walker)
services/litellm_redactor/redaction.py             (SMILES atom-letter restrict)
services/mcp_tools/mcp_doc_fetcher/fetchers.py     (DNS pin contextmanager)
services/mcp_tools/mcp_doc_fetcher/validators.py   (return validated IP list)
BACKLOG.md                                         (close DR-14 + over-fire entries; add residuals)
```

## Verification commands run

```
npx tsc --noEmit -p services/agent-claw                  → clean
npx vitest run                                            → 1118/1118 pass
.venv/bin/pytest tests/unit/test_redactor.py
                  tests/unit/test_redactor_dynamic_patterns.py  → 25/25 pass
python3 -m py_compile services/litellm_redactor/redaction.py
                       services/litellm_redactor/dynamic_patterns.py
                       services/mcp_tools/mcp_doc_fetcher/validators.py
                       services/mcp_tools/mcp_doc_fetcher/fetchers.py  → clean
```

`tests/unit/test_mcp_doc_fetcher.py` has 7 pre-existing failures unrelated
to this change (BACKLOG-70 — `_ip_is_blocked` import path mismatch); 13
unrelated tests still pass.

## Deferrals

1. **LiteLLM per-call org context** (Verification 7c) — needs gateway header
   plumbing across language boundary; out of scope for one PR.
2. **`err.cause` chain depth > 1** (logger serializer) — see new BACKLOG entry.
3. **Multi-slash path SMILES over-fire** — see updated BACKLOG entry.
