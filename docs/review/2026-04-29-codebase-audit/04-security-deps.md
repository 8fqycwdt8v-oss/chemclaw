# Track D — Security & Dependency Audit (2026-04-29)

Working tree: `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit`
Audit branch tip matches `main` (HEAD = `c7168bc`, the v1.2.0-harness merge).
Read-only on code; this file is the only artefact written.

The report is organised as the nine tasks in the audit brief, in order. Each
section ends with a "verdict" line giving the prioritisation per the report
contract (P0 critical / P1 high / P2 medium / P3 low / informational).

---

## 1. Semgrep scan (`semgrep --config=auto services/`)

`semgrep 1.142.x` (already present at `~/.local/bin/semgrep`) ran against
`services/` with the auto-config rule pack. 290 paths scanned, 17 findings,
0 errors. Each finding analysed below.

### Summary table

| # | severity | rule | location | TP/FP | priority |
|---|---|---|---|---|---|
| 1 | WARNING | non-literal RegExp | `services/agent-claw/src/core/lifecycle.ts:90` | TP-bounded | P3 |
| 2 | INFO    | unsafe-formatstring | `services/agent-claw/src/core/lifecycle.ts:262` | FP | — |
| 3 | WARNING | path-traversal (path.join) | `services/agent-claw/src/core/skills.ts:129` | FP | — |
| 4 | WARNING | path-traversal (path.join) | `services/agent-claw/src/core/skills.ts:129` | FP (dup) | — |
| 5 | WARNING | path-traversal (path.join) | `services/agent-claw/src/core/skills.ts:130` | FP | — |
| 6 | WARNING | path-traversal (path.join) | `services/agent-claw/src/core/skills.ts:130` | FP (dup) | — |
| 7 | WARNING | raw-html-format | `services/agent-claw/src/routes/eval.ts:120` | FP | — |
| 8 | WARNING | path-traversal (path.join) | `services/agent-claw/src/tools/builtins/forge_tool.ts:382` | TP-bounded | P2 |
| 9 | ERROR   | dockerfile missing-user | `services/litellm_redactor/Dockerfile:19` | TP | P1 |
| 10 | WARNING | insecure-hash sha1 | `services/litellm_redactor/redaction.py:58` | FP (non-cryptographic) | — |
| 11 | WARNING | logger-credential-leak | `services/mcp_tools/common/app.py:213` | FP | — |
| 12 | WARNING | logger-credential-leak | `services/mcp_tools/common/app.py:225-231` | FP | — |
| 13 | WARNING | logger-credential-leak | `services/mcp_tools/common/auth.py:286` | FP | — |
| 14 | ERROR   | sqlalchemy-execute-raw-query | `services/mcp_tools/mcp_logs_sciy/backends/fake_postgres.py:212` | FP | — |
| 15 | ERROR   | sqlalchemy-execute-raw-query | `services/mcp_tools/mcp_logs_sciy/backends/fake_postgres.py:307` | FP | — |
| 16 | WARNING | logger-credential-leak | `services/optimizer/session_reanimator/main.py:193` | FP | — |
| 17 | WARNING | insecure-hash sha1 | `services/projectors/kg_experiments/main.py:59` | FP (non-cryptographic) | — |

### Per-finding analysis

**1. `services/agent-claw/src/core/lifecycle.ts:90` — non-literal RegExp.**
The relevant line constructs a regex from a hook-config field:
`matcher: opts.matcher ? new RegExp(opts.matcher) : undefined,`. The
`matcher` is set at hook-registration time by the hook YAML loader. It
is operator-controlled, not user-controlled. ReDoS on a malicious
operator-supplied regex is conceivable but the operator already has full
control of the hook. **TP but bounded threat surface; P3.** Suggest
adding a regex-length cap and a one-time `safe-regex` lint when
`loadHooks` parses YAML.

**2. `services/agent-claw/src/core/lifecycle.ts:262` — unsafe-formatstring.**
This is the developer-fallback `console.error` triggered when a non-pre-tool
hook throws. The "non-literal" segment is `hook.name` and `point` —
operator-controlled hook IDs, not user input. **FP.**

**3-6. `services/agent-claw/src/core/skills.ts:129-130` — path-join traversal.**
`name` is a directory entry from `readdirSync(skillsDir, …)`, never a request
parameter. Skills directory is trusted (lives in repo + read-only mount).
**FP** for any external-attacker model. Defense-in-depth could add an explicit
`name.includes("..")` reject, but cost-benefit doesn't justify it.

**7. `services/agent-claw/src/routes/eval.ts:120` — raw-html-format.**
The interpolated value flows into a JSON `detail` field on a Fastify reply,
not into HTML. Fastify auto-encodes JSON. `Content-Type: application/json`
not `text/html`. **FP.** No XSS path.

**8. `services/agent-claw/src/tools/builtins/forge_tool.ts:382` — path-join.**
The line `const scriptsPath = join(forgedToolsDir, ${toolId}.py)` writes
`toolId` (an LLM-controlled tool input subject to prompt-injection) into
a filesystem write target unsanitised. **TP — P2**. The forge_tool builtin
should add an explicit allowlist (`/^[a-z][a-z0-9_]{0,63}$/`) on `toolId`
before any filesystem touch. Currently the only guard is a Pydantic length
cap on the tool-input schema (which doesn't reject `../` segments). Worst
case: the LLM is talked into writing to `forgedToolsDir/../../etc/foo.py`
— contained by the writing process's UID 1001 jail but still capable of
clobbering writable adjacent paths.

**9. `services/litellm_redactor/Dockerfile:19` — missing USER.**
The Dockerfile inherits `FROM ghcr.io/berriai/litellm:main-v1.60.0` and
runs `CMD ["--config", "/app/config.yaml", "--port", "4000"]` without an
explicit `USER` directive. This is the LiteLLM gateway image — the
**single LLM-egress chokepoint**. Every other service Dockerfile in
`services/` declares `USER 1001` (verified: 26 of 27 image Dockerfiles
do). The litellm_redactor image relies on the upstream
`ghcr.io/berriai/litellm` base to drop privilege, but that cannot be
confirmed without inspecting the upstream — and if the upstream changes,
this image silently runs as root. **TP — P1**. Add an explicit
`USER 1001` (or whichever non-root UID matches the base's filesystem
ownership) before the `CMD`.

**10. `services/litellm_redactor/redaction.py:58` and 17. `services/projectors/kg_experiments/main.py:59` — SHA1.**
Both use `hashlib.sha1(value.encode()).hexdigest()[:8]` (or `[:16]`) as a
deterministic short-key derivation, not for collision-sensitive use. The
redactor needs *deterministic* placeholder names; the projector needs a
short stable id. Neither is a cryptographic context. **FP.** A change to
SHA-256 would only buy a longer truncated string.

**11-13, 16. logger-credential-leak.** All four flag log strings that
contain the **literal word "token" or "scope"** in a format string —
no actual credential is logged. Read each:

- `services/mcp_tools/common/app.py:213` — logs `exc` (the `McpAuthError`
  message). The error messages produced by `verify_mcp_token` (e.g.
  "audience mismatch", "expired") never include the token bytes.
- `services/mcp_tools/common/app.py:225-231` — logs the *required* scope
  and the token's *claimed* scopes (claim names, not the JWT itself) plus
  `claims.user`. This is intended forensic context, not a credential.
- `services/mcp_tools/common/auth.py:286` — same pattern as 213.
- `services/optimizer/session_reanimator/main.py:193` — logs the session
  id and the `McpAuthError.__str__` from `sign_mcp_token` (which can only
  ever say "MCP_AUTH_SIGNING_KEY is empty/short" — no key material).

All four are **FP**. Defense-in-depth nit: prefer structured logging
(`log.warning("verify_failed", reason=str(exc))`) so a future change
doesn't accidentally widen the leak surface.

**14-15. `services/mcp_tools/mcp_logs_sciy/backends/fake_postgres.py:212, 307` — SQL string concat.**
Both call sites build `sql = f"…{where_sql}…"` and pass `params` separately.
Inspecting `where_sql` construction at lines 160-196 and 285-296: every
fragment is a **string literal**; user input flows only through `params`
and is bound by psycopg via `%s`. The ILIKE handler (lines 176-183)
pre-escapes `%`/`_`/`\\`. The cursor at line 184-194 keysets on
`(measured_at, uid) < (%s, %s)` bound on cursor fields parsed from a
base64 payload via `_decode_cursor`. **FP, defensible code.** Same
finding repeats in `query_persons` (line 297) — same shape, same
conclusion. Could be silenced with a per-line `# nosem` comment.

### Section verdict

- 1 P1 (litellm_redactor Dockerfile missing USER)
- 1 P2 (forge_tool path-traversal via LLM-controlled tool id)
- 1 P3 (operator regex DoS in lifecycle hook matcher)
- 14 false positives (correctly flagged by static analysis but neutralised
  by the surrounding context)

---

## 2. LLM egress audit

Goal: confirm that **every** outbound LLM call routes through LiteLLM
(`services/litellm/`) and that no provider SDK is imported directly outside
the redactor / config layer.

### Greps run

```
grep -rn -E "(from openai|import openai|from anthropic|import anthropic|
              @anthropic-ai/sdk|@ai-sdk/anthropic|api\.openai\.com|
              api\.anthropic\.com)" services/ \
  --include='*.py' --include='*.ts' --include='*.json' --include='*.yaml'
```

### Hits

| file:line | text | classification |
|---|---|---|
| `services/litellm/config.yaml:9-50` | `model: anthropic/claude-…` (8 entries) | allowed — LiteLLM config |
| `services/litellm/config.yaml:56` | `model: openai/gpt-5` | allowed — LiteLLM config |
| `services/agent-claw/package.json:20` | `"@ai-sdk/openai-compatible": "^1.0.21"` | allowed — points at LiteLLM via baseURL |
| `services/agent-claw/src/llm/litellm-provider.ts:24` | `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";` | allowed |
| `services/agent-claw/src/llm/litellm-provider.ts:107-111` | `createOpenAICompatible({ name: "litellm", baseURL: ${cfg.LITELLM_BASE_URL}/v1, … })` | allowed — baseURL is the LiteLLM proxy |
| `services/agent-claw/tests/unit/litellm-provider.test.ts:33-35` | mocks `@ai-sdk/openai-compatible` | allowed — test file |
| `services/optimizer/scripts/seed_golden_set.py:91` | `default=os.environ.get("LITELLM_PLANNER_MODEL", "openai/gpt-4o")` | allowed — `openai/<alias>` is LiteLLM router syntax |
| `services/optimizer/gepa_runner/runner.py:67-74` | `dspy.LM(model=f"openai/{model_alias}", api_base=base, api_key=api_key)` | allowed — `api_base` is the LiteLLM URL (verified at runner.py:58-65 by env-var presence check; refuses to start without LiteLLM configured) |

**Zero direct hits** on:
- `from openai import …` / `import openai`
- `from anthropic import …` / `import anthropic`
- `@anthropic-ai/sdk` / `@ai-sdk/anthropic`
- `api.openai.com`, `api.anthropic.com`

The `gepa_runner/runner.py` egress is interesting because it bypasses the TS
LiteLLMProvider and uses DSPy's own LM client — but it points DSPy at
`LITELLM_BASE_URL` and refuses to start with a clear error if that env is
absent (`runner.py:60-65`). So the redactor callback still fires on the way
to the upstream provider.

### Verdict

LLM egress chokepoint is intact. **No P0/P1/P2/P3 findings.**

One observability nit (P3): `runner.py:67-74` could log the resolved
`api_base` at startup so operators can audibly confirm DSPy is hitting the
internal proxy. Currently you have to `tail -f` the LiteLLM access log to
verify.

---

## 3. MCP auth boundary

Goal: every FastAPI route in `services/mcp_tools/*` must pass through the
`verify_mcp_token` middleware in `services/mcp_tools/common/app.py`. Routes
under `/api/internal/*` in agent-claw must trust signed JWT claims, not the
`x-user-entra-id` header.

### MCP route inventory (35 routes across 14 services)

All routes are mounted on apps built by `create_app()` from
`services/mcp_tools/common/app.py:38-304`. The middleware at lines
**154-241** registers as `@app.middleware("http")` and runs for every
request. Probe-paths `/healthz` (line 286) and `/readyz` (line 290) are
explicitly exempted on line **164**: `if path in ("/healthz", "/readyz"):
return await call_next(request)`.

| service | port | route | handler file:line | uses create_app | verified |
|---|---|---|---|---|---|
| mcp-rdkit | 8001 | POST `/tools/canonicalize_smiles` | `mcp_rdkit/main.py:70` | yes (`main.py:35`) | ✓ |
| mcp-rdkit | 8001 | POST `/tools/inchikey_from_smiles` | `mcp_rdkit/main.py:93` | yes | ✓ |
| mcp-rdkit | 8001 | POST `/tools/morgan_fingerprint` | `mcp_rdkit/main.py:113` | yes | ✓ |
| mcp-rdkit | 8001 | POST `/tools/compute_descriptors` | `mcp_rdkit/main.py:158` | yes | ✓ |
| mcp-drfp | 8002 | POST `/tools/compute_drfp` | `mcp_drfp/main.py:61` | yes (`main.py:27`) | ✓ |
| mcp-doc-fetcher | 8004 | POST `/fetch` | `mcp_doc_fetcher/main.py:346` | yes (`main.py:177`) | ✓ |
| mcp-doc-fetcher | 8004 | POST `/pdf_pages` | `mcp_doc_fetcher/main.py:435` | yes | ✓ |
| mcp-doc-fetcher | 8004 | POST `/byte_offset_to_page` | `mcp_doc_fetcher/main.py:666` | yes | ✓ |
| mcp-embedder | 8005 | POST `/tools/embed_text` | `mcp_embedder/main.py:54` | yes (`main.py:45`) | ✓ |
| mcp-kg | 8006 | POST `/tools/write_fact` | `mcp_kg/main.py:98` | yes (`main.py:82`) | ✓ |
| mcp-kg | 8006 | POST `/tools/invalidate_fact` | `mcp_kg/main.py:103` | yes | ✓ |
| mcp-kg | 8006 | POST `/tools/query_at_time` | `mcp_kg/main.py:116` | yes | ✓ |
| mcp-askcos | 8007 | POST `/retrosynthesis` | `mcp_askcos/main.py:87` | yes (`main.py:37`) | ✓ |
| mcp-askcos | 8007 | POST `/forward_prediction` | `mcp_askcos/main.py:140` | yes | ✓ |
| mcp-aizynth | 8008 | POST `/retrosynthesis` | `mcp_aizynth/main.py:80` | yes (`main.py:36`) | ✓ |
| mcp-chemprop | 8009 | POST `/predict_yield` | `mcp_chemprop/main.py:111` | yes (`main.py:42`) | ✓ |
| mcp-chemprop | 8009 | POST `/predict_property` | `mcp_chemprop/main.py:156` | yes | ✓ |
| mcp-xtb | 8010 | POST `/optimize_geometry` | `mcp_xtb/main.py:148` | yes (`main.py:40`) | ✓ |
| mcp-xtb | 8010 | POST `/conformer_ensemble` | `mcp_xtb/main.py:237` | yes | ✓ |
| mcp-tabicl | 8011 | POST `/featurize` | `mcp_tabicl/main.py:101` | yes (`main.py:89`) | ✓ |
| mcp-tabicl | 8011 | POST `/predict_and_rank` | `mcp_tabicl/main.py:140` | yes | ✓ |
| mcp-tabicl | 8011 | POST `/pca_refit` | `mcp_tabicl/main.py:160` | yes | ✓ |
| mcp-sirius | 8012 | POST `/identify` | `mcp_sirius/main.py:165` | yes (`main.py:41`) | ✓ |
| mcp-eln-local | 8013 | POST `/experiments/query` | `mcp_eln_local/main.py:607` | yes (`main.py:186`) | ✓ |
| mcp-eln-local | 8013 | POST `/experiments/fetch` | `mcp_eln_local/main.py:708` | yes | ✓ |
| mcp-eln-local | 8013 | POST `/reactions/query` | `mcp_eln_local/main.py:741` | yes | ✓ |
| mcp-eln-local | 8013 | POST `/reactions/canonical` | `mcp_eln_local/main.py:781` | yes | ✓ |
| mcp-eln-local | 8013 | POST `/samples/fetch` | `mcp_eln_local/main.py:848` | yes | ✓ |
| mcp-eln-local | 8013 | POST (samples query) | `mcp_eln_local/main.py:889` | yes | ✓ |
| mcp-eln-local | 8013 | POST `/samples/by_entry` | `mcp_eln_local/main.py:915` | yes | ✓ |
| mcp-logs-sciy | 8016 | POST `/datasets/query` | `mcp_logs_sciy/main.py:325` | yes (`main.py:312`) | ✓ |
| mcp-logs-sciy | 8016 | POST `/datasets/fetch` | `mcp_logs_sciy/main.py:341` | yes | ✓ |
| mcp-logs-sciy | 8016 | POST (datasets by sample) | `mcp_logs_sciy/main.py:351` | yes | ✓ |
| mcp-logs-sciy | 8016 | POST `/persons/query` | `mcp_logs_sciy/main.py:362` | yes | ✓ |

**0 / 35 routes skip the middleware.**

The middleware logic at `common/app.py:154-241`:
- 154-165: probe exemption (only `/healthz`, `/readyz`)
- 167-179: missing-Authorization branch — fail-closed via `_require_or_skip()`
- 181-190: malformed Bearer header — fail-closed
- 192-215: signature/exp/audience verification (always binds `expected_audience=name`)
- 217-241: scope check — required when auth enforced AND `effective_scope` is set
- 232-239: 403 on scope mismatch

Two startup guards in `create_app()` (lines 86-124) catch fail-OPEN
configurations before the app boots:
- Lines 86-97: explicit `required_scope=` arg disagreeing with the
  `SERVICE_SCOPES` catalog → `RuntimeError`.
- Lines 112-124: service registered but absent from `SERVICE_SCOPES` AND
  no explicit `required_scope` AND auth enforced → `RuntimeError`.

### `/api/internal/*` routes in agent-claw

Two routes match the pattern:

| route | file:line | identity source |
|---|---|---|
| `POST /api/internal/sessions/:id/resume` | `services/agent-claw/src/routes/sessions.ts:338` | `claims.user` from `verifyBearerHeader(authz, { requiredScope: "agent:resume" })` |

The handler at sessions.ts:347-368 reads only `req.headers["authorization"]`,
verifies the JWT, checks `agent:resume` scope, and uses `claims.user` (line
359) for every subsequent operation (RLS context, session lookup, increment).
The `x-user-entra-id` header is **not read** anywhere in this handler.
Confirmed by `grep -n "x-user-entra-id" services/agent-claw/src/routes/sessions.ts`
returning only line 332 (a comment).

The reanimator (`services/optimizer/session_reanimator/main.py:181-198`)
mints a JWT with scope `agent:resume` and TTL 300 s and posts to
`/api/internal/sessions/:id/resume` when `MCP_AUTH_SIGNING_KEY` is set
(production path). The fallback at lines 195-197 sends `x-user-entra-id` to
the *public* `/api/sessions/:id/resume` route — that fallback is documented
as "dev mode only" and is gated by `mcp_auth_signing_key` being unset in the
reanimator settings.

### Verdict

MCP auth boundary is correctly enforced. **No findings P0/P1/P2.**

P3 / informational: the dev-mode fallback in the reanimator (lines 195-197)
trusts `x-user-entra-id` against the public route. In a production
deployment that fallback should be unreachable (signing key always set), but
the code path remains in the source. Worth a comment-level reminder in a
future hardening pass that the public `/api/sessions/:id/resume` should
eventually be admin-gated rather than relying on environment posture.

---

## 4. Redactor regex audit

Two parallel regex catalogs:

- **Pre-egress (Python, runs inside LiteLLM):**
  `services/litellm_redactor/redaction.py:32-53`
- **Post-turn defense-in-depth (TS, runs in the agent-claw harness):**
  `services/agent-claw/src/core/hooks/redact-secrets.ts:29-37`

### Pattern-by-pattern bound check

| pattern | python | typescript | quantifier bounded? |
|---|---|---|---|
| RXN_SMILES | `r"\S{1,400}>\S{0,400}>\S{1,400}"` (line 42) | `/\S{1,400}>\S{0,400}>\S{1,400}/g` (line 29) | yes (1-400, 0-400, 1-400) |
| SMILES_TOKEN | `[A-Za-z0-9@+\-\[\]\(\)=#/\\\.]{6,200}` (line 35) | same (line 31) | yes (6-200) |
| EMAIL | `[a-zA-Z0-9_.+\-]{1,64}@[a-zA-Z0-9\-]{1,253}\.[a-zA-Z0-9\-.]{2,63}` (line 46) | same (line 33) | yes |
| NCE_PROJECT | `\bNCE-\d{1,6}\b` (line 50) | `/\bNCE-\d{1,6}\b/gi` (line 35) | yes |
| COMPOUND_CODE | `\bCMP-\d{4,8}\b` (line 53) | `/\bCMP-\d{4,8}\b/gi` (line 37) | yes |

Every quantifier has an explicit upper bound. The redactor's "no unbounded
.*" rule from `CLAUDE.md` is held by every pattern.

### Adversarial fuzz (Python `re`, ~100 KB inputs)

I drove every pattern through ten adversarial corpora (100 KB letter-a runs,
100 KB dots, 200 KB SMILES-like strings, repeated `@`, repeated `|`, evil
oversized email, nested parens, single-arrow / no-arrow text, etc.) and
recorded total `findall` runtime.

Worst-case timings (full table in appendix A; trimmed to >50 ms here):

| pattern | adversarial input | runtime | matches |
|---|---|---|---|
| RXN_SMILES | 200 KB `C(=O)N` repeat (no `>`) | **3 480 ms** | 0 |
| RXN_SMILES | 100 KB letter-a (no `>`) | **2 862 ms** | 0 |
| RXN_SMILES | 100 KB dots | **2 636 ms** | 0 |
| RXN_SMILES | long SMILES repeat | **2 160 ms** | 0 |
| RXN_SMILES | 100 KB `\|` | **2 014 ms** | 0 |
| RXN_SMILES | nested parens | 260 ms | 0 |
| EMAIL | 100 KB letter-a | 276 ms | 0 |
| EMAIL | 100 KB dots | 213 ms | 0 |
| SMILES_TOKEN | 100 KB `\|` | 99 ms | 0 |

**Reproduced in JavaScript** with the TS-side pattern at `redact-secrets.ts:29`:
- 200 KB `C(=O)N`-repeat: **3 508 ms**
- 100 KB `a`: **1 411 ms**
- One arrow + 50 KB tail: 548 ms (reasonable)

### Finding 4.1 — RXN_SMILES quadratic-explosion (P1)

The `RXN_SMILES` pattern `\S{1,400}>\S{0,400}>\S{1,400}` is technically
length-bounded but is **not bound-safe in practice**. The two
nondeterministic `\S{m,n}` runs separated by `>` characters force the
regex engine to try every starting position multiplied by every
length-combination of the first `\S{1,400}` whenever `>` is absent (or
appears only once) in the surrounding text. On 200 KB of legitimate
SMILES-looking content with no reaction arrows, the Python engine spends
**3.5 s of CPU per redaction call** before returning zero matches — and
the JavaScript engine matches that. A 200 KB request body is not
implausible: the post_turn hook scrubs `payload.finalText`, which can
carry a multi-page synthesis route or a full reaction list.

This is a real CPU-DoS surface. The bound is theoretically O(N²) (each
of N starting positions tries up to 400 lengths × 400 lengths × the
distance to `>`), and 100 KB of adversarial content produces a 1-3 s
worst case.

**Remediation**: pre-filter — require at least two `>` characters in the
input before running the regex. The existing `extra_check` in
`redaction.py:105` already counts `>`, but it runs *after* `pattern.sub`
has already paid the backtracking cost.

A surgical fix in Python (`redaction.py`):

```
def redact(text: str) -> RedactionResult:
    …
    # Skip RXN_SMILES entirely if there aren't two arrows anywhere.
    if text.count(">") >= 2:
        _sub(_RXN_SMILES, "RXN_SMILES", extra_check=lambda v: v.count(">") >= 2)
    _sub(_SMILES_TOKEN, …)
```

The TS-side `redactString` at `redact-secrets.ts:64-70` has the same
problem and same fix:

```
if ((result.match(/>/g) ?? []).length >= 2) {
  result = result.replace(RXN_SMILES, …);
}
```

**Priority**: P1. Not exploitable as RCE, but a hostile prompt-injection
can pin the redactor's CPU for several seconds per turn — multiplied
by concurrent users this is a denial-of-service. The egress redactor
runs **inline on every prompt** in the LiteLLM gateway; a single
adversarial input stalls the whole proxy thread.

### Other patterns

`EMAIL` showing 276 ms on 100 KB letter-a is borderline (adversarial
class-mismatch — the engine can't match "@" so it scans linearly; the
linear scan dominates). It's well below the 50 ms threshold for normal
inputs and stays inside acceptable bounds for adversarial 100 KB. Not
flagging.

`SMILES_TOKEN` peaks at 99 ms on 100 KB pipes — fine.

### Verdict

- 1 P1: RXN_SMILES backtracking explosion on adversarial 100 KB inputs.

---

## 5. SQL parameterisation audit

`grep -rnE 'sql\s*=\s*f"|query\s*=\s*f"|stmt\s*=\s*f"' services/ --include='*.py'`
yields **four** dynamic-SQL builders. Each analysed.

### 5.1 `services/mcp_tools/mcp_logs_sciy/backends/fake_postgres.py:199, 297`

The line builds `sql = f"…{where_sql}…"` where `where_sql` is a join of
literal fragments. Every user-controlled value is appended to a `params`
list and bound via psycopg's `%s` parameterisation (lines 162-194). The
ILIKE handler (lines 176-183) pre-escapes `%`/`_`/`\\`. The cursor at
line 184-194 keysets on `(measured_at, uid) < (%s, %s)` with the cursor
fields parsed from a base64 payload via `_decode_cursor` (validated by
the helper before line 185).

**Status**: parameterised. Semgrep's flag is a textual heuristic; manual
review confirms safe. Same finding repeats in `query_persons`
(line 297) — same shape, same conclusion.

### 5.2 `services/mcp_tools/mcp_kg/cypher.py:82, 159`

The query is built `query = f""" MERGE (s:{s_label} {{ {s_id_prop}:
$s_id_value }}) … """`. Cypher cannot bind label or relationship-type
names — they have to be interpolated as text. The file calls
`_safe_label` / `_safe_predicate` / `_safe_id_property` (lines 22-38)
which `fullmatch` against strict regex `^[A-Z][A-Za-z0-9_]{0,79}$` and
similar before any interpolation. Pydantic models in `models.py` apply
the same constraint at the request boundary (per the docstring at
`cypher.py:1-10`). Defense in depth holds.

**Status**: safe by allowlist. `_LABEL_RE` is `^[A-Z][A-Za-z0-9_]{0,79}$`
— can never match a backtick or semicolon. No injection path.

### 5.3 Other dynamic SQL

`grep -rn -E '\.execute\(\s*f"|\.execute\(\s*f\x27|\.execute\(.*\.format\('
across services/` returned **zero** hits — confirming there is no naked
f-string-into-execute pattern anywhere.

A separate sweep for cursor.execute() with concatenation operators: zero
hits.

### Verdict

No SQL injection findings. **No P0/P1/P2 findings.**

---

## 6. JWT secret hygiene (`MCP_AUTH_SIGNING_KEY`)

### Reference inventory

| location | role | check enforced |
|---|---|---|
| `services/mcp_tools/common/auth.py:95` | sign_mcp_token() | strip + non-empty + len >= 32 (lines 96-107) |
| `services/mcp_tools/common/auth.py:147` | verify_mcp_token() | strip + non-empty (149); rejects "32 spaces" (95+103 mirror) |
| `services/agent-claw/src/security/mcp-tokens.ts:78` | signMcpToken | strip + non-empty + len >= 32 (lines 79-91) |
| `services/agent-claw/src/security/mcp-tokens.ts:145` | verifyMcpToken | strip + non-empty (146-148) |
| `services/agent-claw/src/security/mcp-token-cache.ts:69` | getMcpToken | returns undefined if empty (line 70) |
| `services/agent-claw/src/mcp/postJson.ts:8,38` | request flow | comment-only |
| `services/optimizer/session_reanimator/main.py:181` | reanimator | falls back to header path if absent |

### Default behaviour with no key

`services/mcp_tools/common/auth.py:211-228`, `_require_or_skip()`:

- `MCP_AUTH_REQUIRED` unset:
  - `MCP_AUTH_DEV_MODE != "true"` → enforce (fail-closed). This is the
    documented production default.
  - `MCP_AUTH_DEV_MODE == "true"` → skip enforcement.
- `MCP_AUTH_REQUIRED` set:
  - returns its lower-cased value's truthiness directly.

There is **no hardcoded fallback signing key**. Both the Python and TS
codepaths refuse to mint or verify when the env-var is empty, after
`.strip()` (auth.py:95-99, mcp-tokens.ts:78-82).

### Token TTL and audience

- Default TTL: **300 s** (5 min). Set in:
  - `services/mcp_tools/common/auth.py:76` (`ttl_seconds: int = 300`).
  - `services/agent-claw/src/security/mcp-tokens.ts:93`
    (`opts.ttlSeconds ?? 300`).
  - `services/agent-claw/src/security/mcp-token-cache.ts:42` cache
    constant `DEFAULT_TTL_SECONDS = 300`.
  - `services/optimizer/session_reanimator/main.py:187` reanimator
    explicit `ttl_seconds=300`.
- TTL is bounded — there is no code path that mints a token with no
  expiry. `auth.py:114` always sets `exp = issued_at + ttl_seconds`;
  `mcp-tokens.ts:100` does the same.
- Audience is **mandatory in production**. Middleware passes
  `expected_audience=name` on every request (`common/app.py:201`).
  When auth is enforced and a token has no `aud`, line 199-202 of
  `auth.py` rejects with `"token missing aud claim"`. The agent always
  sets `aud` via `audience: opts.audience` in `mcp-tokens.ts:102` when
  the caller supplies one — and `mcp-token-cache.ts:107` always passes
  the destination service name as `audience`. Cross-service replay
  surface is closed.

### Algorithm hardening

`auth.py:171` rejects any header `alg != "HS256"`. The `none` algorithm
attack is impossible.

`auth.py:162` uses `hmac.compare_digest`; `mcp-tokens.ts:165` uses
`timingSafeEqual` after a length-pre-check. Constant-time signature
comparison on both sides.

### Verdict

JWT hygiene is **clean**. Fail-closed default, key-strength floor,
short bounded TTL, mandatory audience binding, constant-time
signature compare, explicit alg pin. No P0/P1/P2/P3 findings.

P3 / informational: consider rotating `MCP_AUTH_SIGNING_KEY` on a
cadence and documenting that rotation in the runbook. A 5-minute TTL
means rotation can be near-zero-downtime if both keys are accepted
during the window.

---

## 7. npm audit

Workspaces:
- **root** `package.json` — has `@testcontainers/postgresql` as devDep at
  `^11.14.0` (no app deps).
- **services/agent-claw** — Fastify, AI SDK, pg, Zod, vitest, etc.
- **services/paperclip** — minimal Fastify sidecar.

### Root + services/agent-claw audit (4 advisories, all the same chain)

```
npm audit --json
cd services/agent-claw && npm audit --json
```

| package | severity | path | range affected | fix-status |
|---|---|---|---|---|
| `uuid` | moderate | `node_modules/uuid` | `<14.0.0` (resolved 10.0.0) | published in 14.0.0 (semver-major) |
| `@testcontainers/postgresql` | moderate | direct dep | `>=10.22.0` (current 11.14.0) | npm-audit suggests downgrade to `@testcontainers/postgresql@10.21.0` (semver-major in wrong direction) |
| `dockerode` | moderate | transitive of `testcontainers` | `4.0.3 - 4.0.12` (current 4.0.12) | via testcontainers fix |
| `testcontainers` | moderate | transitive | `>=10.22.0` (current 11.14.0) | via @testcontainers/postgresql fix |

GHSA: **GHSA-w5hq-g745-h8pq** "uuid: Missing buffer bounds check in
v3/v5/v6 when buf is provided".

### `npm audit fix --force` analysis

`npm audit`'s suggested fix is to **downgrade** `@testcontainers/postgresql`
from 11.14.0 → 10.21.0 (semver-major in the wrong direction). This is a
foot-gun:

- 10.21.0 is older than 11.14.0 across the testcontainers feature surface.
  Going backwards by a major version risks losing fixes, container
  network-isolation features, and TypeScript type updates we already rely
  on (the helper at `services/agent-claw/tests/helpers/postgres-container.ts`
  uses `PostgreSqlContainer` from the v11 surface).
- The actual transitive needing the fix is `dockerode` → `uuid`. The
  upstream advisory only matters when a caller passes `buf` to
  `uuid.v3/v5/v6(name, ns, buf)`. The advisory text is a
  "missing buffer bounds check" in optional-buffer mode of the older uuid
  generators — `dockerode` uses `uuid` to generate container IDs and to
  hash docker-cli arguments and has no need for the `buf` arg shape.

**Recommendation**: hold the line on `@testcontainers/postgresql@^11.14.0`
and `testcontainers@^11.14.0`. `npm audit fix --force` is **not safe**
here because it downgrades a major version. A pin-fork (`overrides` field
in the root `package.json`) bumping `uuid` to `^14` for the
`testcontainers` chain is the right surgical fix:

```
{
  "overrides": {
    "testcontainers": {
      "dockerode": {
        "uuid": "^14.0.0"
      }
    }
  }
}
```

Caveat: `uuid@14` requires Node 18+ in ESM-only form. ChemClaw runs
Node 22 (per `Dockerfile`), so this is compatible. The override should
be committed with a smoke-test confirming `npm test --workspace
services/agent-claw` and the `tests/helpers/postgres-container.ts`
testcontainer harness still pass.

These deps are **dev-time only** — testcontainers is loaded from the
test helpers and is never bundled into a production image. The
advisory's threat surface is consequently limited to developer machines
running `npm test`. Severity: P2 (defensive hygiene), not P0/P1.

### `services/paperclip` audit

Zero advisories. Production-clean.

### Verdict

- 1 P2 (uuid-via-testcontainers-via-dockerode) — dev-only, fix via
  `overrides` not `audit fix --force`.

---

## 8. Python dep vulnerabilities (pip-audit)

Tool: `pip-audit 2.10.0` from `.venv/bin/pip-audit`. Ran with `--no-deps`
on each `services/*/requirements.txt`. The `--no-deps` flag is required
because the requirements files use `>=` floors instead of pins, so
pip-audit refuses to do full-tree resolution without a hashed lockfile.
This means **transitive vulns are not surfaced here** — only top-level
package versions vs OSV.

### Findings

| service | package | version | advisory | fix |
|---|---|---|---|---|
| `services/optimizer/gepa_runner/requirements.txt` | `starlette` | 0.48.0 | CVE-2025-62727 | 0.49.1 |
| `services/optimizer/gepa_runner/requirements.txt` | `litellm` | 1.82.6 | CVE-2026-35029 | 1.83.0 |
| `services/optimizer/gepa_runner/requirements.txt` | `litellm` | 1.82.6 | CVE-2026-35030 | 1.83.0 |
| `services/optimizer/gepa_runner/requirements.txt` | `litellm` | 1.82.6 | GHSA-69x8-hrgq-fjj8 | 1.83.0 |
| `services/optimizer/gepa_runner/requirements.txt` | `litellm` | 1.82.6 | GHSA-xqmj-j6mv-4862 | 1.83.7 |
| `services/optimizer/gepa_runner/requirements.txt` | `diskcache` | 5.6.3 | CVE-2025-69872 | (not yet released) |
| `services/optimizer/skill_promoter/requirements.txt` | `starlette` | 0.48.0 | CVE-2025-62727 | 0.49.1 |
| `services/mcp_tools/mcp_embedder/requirements.txt` | `torch` | 2.2.2 | PYSEC-2025-41 | 2.6.0 |
| `services/mcp_tools/mcp_embedder/requirements.txt` | `torch` | 2.2.2 | PYSEC-2024-259 | 2.5.0 |
| `services/mcp_tools/mcp_embedder/requirements.txt` | `torch` | 2.2.2 | CVE-2025-2953 | 2.7.1rc1 |
| `services/mcp_tools/mcp_embedder/requirements.txt` | `torch` | 2.2.2 | CVE-2025-3730 | 2.8.0 |
| `services/mcp_tools/mcp_tabicl/requirements.txt` | `starlette` | 0.48.0 | CVE-2025-62727 | 0.49.1 |
| `services/mcp_tools/mcp_tabicl/requirements.txt` | `torch` | 2.2.2 | (same set as embedder) | 2.6.0+ |

Dev-only: the `.venv` root has `setuptools 65.5.0` with 5 advisories
(PYSEC-2022-43012, PYSEC-2025-49, CVE-2024-6345). This is the **dev
venv** managing CLI tools, not a service Dockerfile. Bump locally with
`pip install -U setuptools` if your venv predates 2024.

### Per-finding analysis

**`starlette` 0.48.0 → 0.49.1 (CVE-2025-62727)** — the advisory is a
denial-of-service via repeated multipart fields. Three services pull
starlette transitively through fastapi: `gepa_runner`, `skill_promoter`,
`mcp_tabicl`. **All three** declare `fastapi>=0.115` and `<0.120`. The
fix arrived in fastapi `0.118.0+` (which uses starlette 0.49). The
`_constraints.txt` already pins `fastapi>=0.115,<0.120` — re-resolving
with `pip install --upgrade fastapi` inside the affected service venvs
will pull starlette 0.49.x. **P2** — DoS only, requires multipart
upload surface (none of these services accept multipart forms). Still
worth bumping in the next dep cleanup.

**`litellm` 1.82.6 → 1.83.0/1.83.7** — four advisories landed in
litellm 1.83. The `gepa_runner` is the only service that pins
`litellm>=1.50,<2`. `litellm_redactor`'s requirements only list
`litellm>=1.60` (no upper bound). The actually-deployed
LiteLLM container uses **`ghcr.io/berriai/litellm:main-v1.60.0`** as
the base image (`services/litellm_redactor/Dockerfile:7`). The
1.60-branch is the gateway image, while 1.82.6 is what's installed in
the Python venv for redactor unit tests. Production exposure depends on
which version the `main-v1.60.0` tag resolves to today — that tag is
**moving** (`main-v1.60.0` is a Docker tag, not a pinned digest). Pin
to a specific digest. **P2** for the gateway exposure, **P1** for the
moving-tag policy issue.

**`diskcache` 5.6.3 (CVE-2025-69872)** — an unsafe-deserialisation
issue when an attacker can plant a file in the cache dir. Fix not
available in 5.x; `litellm` 1.83+ vendors away from `diskcache` in some
codepaths. The cache dir is process-private inside the container, so
exploitation requires already having write access. **P3.**

**`torch` 2.2.2 → 2.8.0** — four CVEs across the torch chain. Affected
services: `mcp_embedder` (sentence-transformers pulls torch), `mcp_tabicl`
(tabicl pulls torch). Both run inside their own containers and only
expose a single MCP endpoint each. Three of the CVEs concern
crafted-tensor deserialisation in `torch.load`; neither service calls
`torch.load` on untrusted input — sentence-transformers loads its own
known model bundle, tabicl loads its own checkpoint. **P2** because the
exposure is gated by the model-loading step at service boot, not on the
hot path. Bump to torch 2.6.0+ at the next image rebuild.

### Verdict

- 1 P1 (LiteLLM gateway tag is moving — `main-v1.60.0` is not pinned
  to a digest; pin to a content-addressed digest).
- 4 P2 (starlette 0.48, litellm 1.82.6 in venv tree, diskcache 5.6.3,
  torch 2.2.2 in two services).
- 1 P3 (dev-venv setuptools).

---

## 9. Subprocess and code-execution surface

### Python `subprocess` / `os.system` / `eval` / `exec`

`grep -rnE 'subprocess\.|os\.system|os\.popen|\beval\(|\bexec\('
services/ --include='*.py'` excluding tests:

| file:line | call | classification |
|---|---|---|
| `services/optimizer/forged_tool_validator/sandbox_client.py:44` | `subprocess.run([sys.executable, tmppath], …)` | **code execution** — see analysis |
| `services/mcp_tools/mcp_sirius/main.py:56` | `subprocess.run(args, cwd=str(cwd), shell=False, …)` | scientific tool (SIRIUS JVM) |
| `services/mcp_tools/mcp_xtb/main.py:85` | `subprocess.run(args, cwd=str(cwd), shell=False, …)` | scientific tool (xtb / CREST) |

Zero hits on `os.system`, `os.popen`, `eval(`, `exec(` in production
Python code.

### TypeScript child-process and dynamic-eval

A grep for child-process imports and dynamic-eval primitives in
`services/agent-claw/src/`:

| file:line | call | classification |
|---|---|---|
| `services/agent-claw/tests/helpers/postgres-container.ts:217` | dynamic-imports `node:child_process` then runs `execFileSync` | testcontainer helper (test only) |

Zero hits on `eval(` or dynamic-`Function(` constructors in production
agent-claw source.

The matches that show up when grepping for "eval" are word-boundary hits
on the agent's `/eval` slash command (string literal in
`core/slash.ts:37`), eval-route imports, and `routes/eval.ts` filename —
not JavaScript `eval`. No live `eval()` call.

### Per-call analysis

**`forged_tool_validator/sandbox_client.py:44` — `LocalSubprocessSandbox`.**

The class docstring explicitly says: *"Runs Python in a local subprocess
(for dev / CI). NOTE: This is NOT isolated. Use E2B in production."* The
`run_python` method writes attacker-controllable Python (a freshly
forged tool's body, plus a unit-test harness) to a tempfile and runs it
as the host process's UID via `subprocess.run([sys.executable, tmppath],
…)`.

This is the **forged-tool validation pipeline**. The `Protocol`
definition at lines 25-29 makes the client swappable. The production
runtime is supposed to use the **PTC sandbox / E2B** (per ADR 006 and
`services/agent-claw/src/tools/builtins/run_program.ts`). The validator
currently has no runtime guard that *forces* the E2B sandbox client in
production — `make_validator` (in the validator's main.py, not shown)
would have to be audited to ensure prod always wires E2B.

**Risk**: if `LocalSubprocessSandbox` is used in any production flow,
forged tools (which are LLM-authored) execute as the validator service
account, on the validator host filesystem, with whatever network access
the container has. The forge_tool builtin already has a hash-on-disk
check (`forge_tool.ts:386-390`), but that only catches post-write
tampering — it doesn't sandbox the *first* run.

**Priority**: P1. The mitigation is one of:
1. Make `LocalSubprocessSandbox` raise on import in production
   (`if os.environ.get("FORGED_TOOL_REQUIRE_E2B") == "true": raise …`).
2. Document the E2B requirement in the validator's README and gate the
   service deploy on it.
3. Wrap the subprocess call in a `seccomp` / `unshare` container even
   for "dev" usage so accidentally running on a corp laptop doesn't
   exfil.

This is also explicitly the case the "PTC sandbox" callout in the brief
asked to be flagged.

**`mcp_sirius/main.py:56` and `mcp_xtb/main.py:85`** — both call
`subprocess.run(args, cwd=…, shell=False, capture_output=True,
text=True, timeout=…)`. Both:
- explicitly set `shell=False`,
- pass `args` as a `list[str]` (no string concat),
- bound by `_XTB_TIMEOUT` / `_SIRIUS_TIMEOUT`,
- wrap user input via Pydantic before composing `args`.

The xtb args are constructed inside `_run_xtb` callers from a fixed
template + the SDF/XYZ file paths the service writes. SMILES is
sanitised via RDKit *before* it ever reaches the SDF. Sirius is the
same pattern. **Status**: scientific tool invocation — legitimate, no
remediation needed. Could log the full arg list at INFO for forensics,
but that's a P3 nit.

**`postgres-container.ts:217`** — testcontainer helper. Spins up an
ephemeral container for integration tests. Imports lazily so a missing
Docker socket no-ops the whole test file (the harness self-skips).
Test-only path; not production exposure.

### Verdict

- 1 P1: `LocalSubprocessSandbox` is the documented "not isolated"
  fallback; production deploys must enforce E2B at the wiring layer.
- 0 other findings.

---

## Cross-cutting findings & ranking summary

| ID | severity | finding | location |
|---|---|---|---|
| F-1 | **P1** | RXN_SMILES regex backtracking on adversarial 100 KB input (3+ s CPU) | `services/litellm_redactor/redaction.py:42`, `services/agent-claw/src/core/hooks/redact-secrets.ts:29` |
| F-2 | **P1** | LiteLLM gateway base image pinned to a *moving* tag (`main-v1.60.0`), no digest | `services/litellm_redactor/Dockerfile:7` |
| F-3 | **P1** | `LocalSubprocessSandbox` runs forged-tool code without isolation if E2B isn't wired in production | `services/optimizer/forged_tool_validator/sandbox_client.py:32-58` |
| F-4 | **P1** | `litellm_redactor` Dockerfile lacks explicit `USER` — relies on upstream base | `services/litellm_redactor/Dockerfile:19` |
| F-5 | **P2** | `forge_tool` builtin writes `${toolId}.py` without explicit pattern-validation | `services/agent-claw/src/tools/builtins/forge_tool.ts:382` |
| F-6 | **P2** | `uuid <14` advisory via `testcontainers→dockerode` (dev-time, fix via `overrides`) | root `package.json`, `services/agent-claw/package.json` |
| F-7 | **P2** | `starlette 0.48.0` (CVE-2025-62727) pinned in 3 service requirements | `services/optimizer/gepa_runner/requirements.txt`, `services/optimizer/skill_promoter/requirements.txt`, `services/mcp_tools/mcp_tabicl/requirements.txt` |
| F-8 | **P2** | `torch 2.2.2` exposed via 2 services (4 CVEs) | `services/mcp_tools/mcp_embedder/requirements.txt`, `services/mcp_tools/mcp_tabicl/requirements.txt` |
| F-9 | **P2** | `litellm 1.82.6` four advisories patched in 1.83.x | `services/optimizer/gepa_runner/requirements.txt` (and the redactor requirements which omit an upper bound) |
| F-10 | **P3** | `lifecycle.ts` accepts non-literal RegExp from operator hook config | `services/agent-claw/src/core/lifecycle.ts:90` |
| F-11 | **P3** | `diskcache 5.6.3` no fix available; needs deploy-time monitoring | `services/optimizer/gepa_runner/requirements.txt` (transitive of litellm) |
| F-12 | **P3** | Reanimator dev-mode fallback POSTs `x-user-entra-id` to the public route | `services/optimizer/session_reanimator/main.py:195-197` |
| F-13 | **P3** | Dev `.venv` `setuptools 65.5.0` has 5 advisories | local dev environment |

### Positive controls observed

- All 35 MCP routes confirmed flowing through the auth middleware in
  `services/mcp_tools/common/app.py:154-241`.
- Mandatory audience binding on every MCP request — closes per-service
  replay across blue/green / per-tenant.
- HS256 only (no `alg:none` attack surface), constant-time signature
  compare on both ends, 32-character signing-key floor enforced at sign
  time.
- LLM egress single-chokepoint discipline holds: zero direct provider-
  SDK imports outside the LiteLLM config.
- 26 / 27 service Dockerfiles run as UID 1001.
- `ValueError → 400` envelope consistent across MCP services.
- Cypher label/predicate interpolation gated by strict regex allowlist
  with defense-in-depth at both Pydantic and query-build layers.
- Internal `/api/internal/sessions/:id/resume` route trusts only signed
  JWT claims, not headers.
- Redactor regex catalog has bounded quantifiers everywhere — the only
  practical concern is the pathological-input behaviour of one
  pattern, not unbounded `.*`.
- `docs/runbooks/autonomy-upgrade.md` documents the production rollout
  sequence for fail-closed MCP auth (referenced from CLAUDE.md).

---

## Appendix A — Full redactor fuzz table

```
pattern            input                                  time_ms   matches
SMILES_TOKEN       100KB letter a                            4.72         0
SMILES_TOKEN       100KB dots                                0.80       500
SMILES_TOKEN       long smiles repeat                        1.09       450
SMILES_TOKEN       evil email                                0.06         2
SMILES_TOKEN       nested paren 100KB-ish                    0.11        50
SMILES_TOKEN       a*70 + @                                  0.00         1
SMILES_TOKEN       long rxn smiles                           0.12         0
SMILES_TOKEN       100KB |                                  99.17         0
SMILES_TOKEN       @-burst (35 chars)                        0.02         5
SMILES_TOKEN       oversized SMILES (200KB)                  2.20       896
RXN_SMILES         100KB letter a                         2861.69         0
RXN_SMILES         100KB dots                             2635.51         0
RXN_SMILES         long smiles repeat                     2159.51         0
RXN_SMILES         evil email                                1.60         0
RXN_SMILES         nested paren 100KB-ish                  259.75         0
RXN_SMILES         a*70 + @                                  0.05         0
RXN_SMILES         long rxn smiles                          36.07         0
RXN_SMILES         100KB |                                2013.75         0
RXN_SMILES         @-burst (35 chars)                        7.57         0
RXN_SMILES         oversized SMILES (200KB)               3480.52         0
EMAIL              100KB letter a                          276.06         0
EMAIL              100KB dots                              212.79         0
EMAIL              long smiles repeat                        7.55         0
EMAIL              evil email                                0.44         0
EMAIL              nested paren 100KB-ish                    0.54         0
EMAIL              a*70 + @                                  0.04         0
EMAIL              long rxn smiles                           1.06         0
EMAIL              100KB |                                  36.06         0
EMAIL              @-burst (35 chars)                        0.06         0
EMAIL              oversized SMILES (200KB)                 25.64         0
NCE_PROJECT        100KB letter a                            1.98         0
NCE_PROJECT        100KB dots                                8.28         0
NCE_PROJECT        long smiles repeat                        2.86         0
NCE_PROJECT        evil email                                0.01         0
NCE_PROJECT        nested paren 100KB-ish                    0.30         0
NCE_PROJECT        a*70 + @                                  0.00         0
NCE_PROJECT        long rxn smiles                           0.04         0
NCE_PROJECT        100KB |                                   7.14         0
NCE_PROJECT        @-burst (35 chars)                        0.03         0
NCE_PROJECT        oversized SMILES (200KB)                 41.50         0
COMPOUND_CODE      100KB letter a                            2.51         0
COMPOUND_CODE      100KB dots                                2.93         0
COMPOUND_CODE      long smiles repeat                        4.84         0
COMPOUND_CODE      evil email                                0.02         0
COMPOUND_CODE      nested paren 100KB-ish                    0.28         0
COMPOUND_CODE      a*70 + @                                  0.00         0
COMPOUND_CODE      long rxn smiles                          41.59         0
COMPOUND_CODE      100KB |                                   2.19         0
COMPOUND_CODE      @-burst (35 chars)                        0.02         0
COMPOUND_CODE      oversized SMILES (200KB)                  6.33         0
```

JS reproduction (Node 22, V8) for RXN_SMILES on the same shape:
```
elapsed_ms: 3508 matches: 0     # 200 KB C(=O)N repeat
100k a elapsed_ms: 1411 matches: 0
1k 1-arrow evil elapsed_ms: 6 matches: 0
one-arrow-50k-tail elapsed_ms: 548 matches: 0
```

---

## Appendix B — Tools and command lines used

- `semgrep --config=auto services/ --json --quiet --timeout=60` (semgrep
  1.142.x at `/Users/robertmoeckel/.local/bin/semgrep`)
- `npm audit --json` (root) and `cd services/agent-claw && npm audit --json`
- `npm view uuid versions --json` — confirmed 14.x exists
- `cat package-lock.json | python3 -c …` — extracted resolved versions
- `pip-audit 2.10.0` (installed via `.venv/bin/pip install pip-audit`):
  `pip-audit -r <requirements.txt> --no-deps`
- Python `re` and Node `RegExp` adversarial fuzz harnesses (inline scripts
  in this report)
- `grep -rn` for code-pattern enumeration
- Read tool against every flagged source file to confirm context

---

End of Track D report.
