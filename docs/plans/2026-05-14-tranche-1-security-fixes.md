# Tranche 1 — Security & Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 6 known security/correctness gaps from BACKLOG.md in a single reviewable branch.

**Architecture:** One branch off main → one PR → `/review` → merge. Each task is its own commit so the diff is reviewable item-by-item. TDD where the existing surface has test infrastructure (Vitest under `services/agent-claw/tests/unit/`, pytest under `services/mcp_tools/`). One BACKLOG.md rewrite task at the end captures items that didn't fit (A9).

**Tech Stack:** TypeScript (agent-claw), Python (mcp_tools/common, mcp_embedder), Postgres (etag-bearing tables already exist).

**Items in scope:**

| ID | Item | BACKLOG ref |
|---|---|---|
| A1 | PolicyMatchContext org/nce_project plumbing | lines 82, 130 |
| A4 | Defense-in-depth scrub of MCP tool responses | line 208 |
| A6 | `MCP_AUTH_SIGNING_KEY_NEXT` dual-key rotation | line 67 |
| A7 | `recommend_next_batch` bumps `optimization_campaigns.etag` | lines 14, 57 |
| A8 | `advance_synthesis_campaign._claim` bumps campaign etag | line 193 |
| A10 | `mcp_embedder` fail-loud on stub-encoder outside dev mode | line 290 |

**Items bounced (with note):**

| ID | Item | Reason |
|---|---|---|
| A9 | `tag-maturity` / `propose_hypothesis` `ON CONFLICT` upsert | Neither `artifacts` nor `hypotheses` has a natural-key unique constraint. `ON CONFLICT` requires a target. Picking the key (e.g. `(tool_id, sha256(payload))` for artifacts; `(scope_nce_project_id, sha256(hypothesis_text))` for hypotheses) is a design decision — bounced to BACKLOG with that question. |

**Success criteria (define up front, verify before claiming done):**

- `npm run --workspace services/agent-claw test` passes with new tests added.
- `npx tsc --noEmit --project services/agent-claw` clean.
- `.venv/bin/pytest services/mcp_tools/common/tests/test_auth.py services/mcp_tools/mcp_embedder/tests/ -v` passes.
- `gh pr create` → CI green → `/review` clean → `gh pr merge --merge` → remote + local branch deleted.

---

## File Structure

**TypeScript — `services/agent-claw/`:**

- `src/core/types.ts` — add `orgId?: string | null`, `nceProjectId?: string | null` to `ToolContext`. (A1)
- `src/core/permissions/policy-loader.ts` — `PolicyMatchContext.org` / `.project` change from `?: string` to `: string | null`. (A1)
- `src/core/permissions/resolver.ts` — log structured WARN when policies match by tool-pattern but org-scoped policies exist with unbound `ctx.orgId`. (A1)
- `src/core/hooks/permission.ts` — read from `payload.ctx.orgId` / `payload.ctx.nceProjectId` instead of the `as { orgId? }` no-op cast. (A1)
- `src/routes/chat.ts`, `src/routes/plan.ts`, `src/routes/deep-research.ts`, `src/routes/workflow-sub-agent.ts`, `src/core/chained-harness.ts` (×2), `src/core/sub-agent.ts` — pass `orgId: null, nceProjectId: null` (or threaded value when available) at each `ToolContext` construction site. (A1)
- `src/core/hooks/redact-tool-output.ts` — **new file**, post_tool hook running `redactString` over stringified tool output. (A4)
- `hooks/redact-tool-output.yaml` — **new file**, declares lifecycle phase. (A4)
- `src/core/hook-loader.ts` — register `redact-tool-output` in `BUILTIN_REGISTRARS`. (A4)
- `src/bootstrap/start.ts` — bump `MIN_EXPECTED_HOOKS` from current (25) to 26. (A4)
- `src/security/mcp-tokens.ts` — `verifyMcpToken` accepts `MCP_AUTH_SIGNING_KEY` and (if set) `MCP_AUTH_SIGNING_KEY_NEXT`, returns valid if either verifies. Mint always uses primary. (A6)
- `src/tools/builtins/recommend_next_batch.ts` — bump `optimization_campaigns.etag` after the round INSERT inside the same txn. (A7)
- `src/tools/builtins/advance_synthesis_campaign.ts` — bump `synthesis_campaigns.etag` in the `_claim` UPDATE branch (currently doesn't). (A8)

**Python — `services/mcp_tools/`:**

- `common/auth.py` — `verify_mcp_token` tries `MCP_AUTH_SIGNING_KEY`, then `MCP_AUTH_SIGNING_KEY_NEXT` on first-key miss; logs a one-shot INFO when next-key verifies. (A6)
- `mcp_embedder/main.py` — `_build_encoder` raises `RuntimeError` when `embed_model_name == "stub-encoder"` and `CHEMCLAW_DEV_MODE != "true"`. (A10)

**Tests — new + updated:**

- `services/agent-claw/tests/unit/permission-policy-aggregation-matrix.test.ts` — extend to assert org/project bind through ToolContext. (A1)
- `services/agent-claw/tests/unit/permission-enforce-mode.test.ts` — assert WARN when ctx.orgId is null but org-scoped policy exists. (A1)
- `services/agent-claw/tests/unit/hooks/redact-tool-output.test.ts` — **new**. (A4)
- `services/agent-claw/tests/unit/mcp-tokens.test.ts` — extend with dual-key verify cases. (A6)
- `services/mcp_tools/common/tests/test_auth.py` — extend with `MCP_AUTH_SIGNING_KEY_NEXT` cases. (A6)
- `services/agent-claw/tests/unit/builtins/optimization_campaign.test.ts` — extend `recommend_next_batch` describe to assert etag bump. (A7)
- `services/agent-claw/tests/unit/builtins/synthesis_campaign.test.ts` — extend `advance_synthesis_campaign` describe to assert etag bump on `_claim`. (A8)
- `services/mcp_tools/mcp_embedder/tests/test_fail_loud.py` — **new**. (A10)

**Repo housekeeping:**

- `BACKLOG.md` — rewrite line 212 (A9) to capture the natural-key design question; mark A1, A4, A6, A7, A8, A10 entries as DONE with date stamp.
- `CLAUDE.md` — bump `MIN_EXPECTED_HOOKS` note to reflect the new hook count.

---

## Task 1: Branch setup + baseline verification

**Files:** none modified yet.

- [ ] **Step 1: Confirm clean working tree**

Run: `git status --porcelain`
Expected: empty output (`git status` shows nothing staged or modified).

If untracked files exist (e.g. the "* 2.sql" duplicates from the gitStatus snapshot at session start), inspect and remove or stash — do NOT include them in this branch.

- [ ] **Step 2: Create branch off main**

```bash
git checkout main
git pull origin main
git checkout -b claude/tranche-1-security-fixes
```

- [ ] **Step 3: Capture baseline test counts**

Run: `npm test --workspace services/agent-claw --silent 2>&1 | tail -5`
Note the current passed/skipped count (CLAUDE.md says 1497 passed / 12 skipped as of current branch).

Run: `.venv/bin/pytest services/mcp_tools/common/tests/test_auth.py services/mcp_tools/mcp_embedder/ -q 2>&1 | tail -3`
Note the current pass count.

These are the floor — every later task must not regress them.

---

## Task 2: A6 — MCP_AUTH_SIGNING_KEY_NEXT dual-key (Python first, TDD)

**Files:**
- Modify: `services/mcp_tools/common/auth.py:128-209` (`verify_mcp_token`)
- Modify: `services/mcp_tools/common/tests/test_auth.py`

**Why first:** smallest blast radius — pure unit change, no cross-file plumbing, gives us a warm-up commit on the branch.

- [ ] **Step 1: Write the failing tests**

Add to `services/mcp_tools/common/tests/test_auth.py`:

```python
def test_verify_accepts_token_signed_with_next_key(monkeypatch):
    """A token minted under MCP_AUTH_SIGNING_KEY_NEXT verifies during rotation window."""
    primary = "p" * 32
    next_key = "n" * 32
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", primary)
    # Mint with the NEXT key (simulating a service that already rotated).
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", next_key)
    token = sign_mcp_token(scope="agent:invoke", user="u@example.com", ttl_seconds=60)
    # Restore primary; next_key now lives in MCP_AUTH_SIGNING_KEY_NEXT.
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", primary)
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY_NEXT", next_key)
    claims = verify_mcp_token(token, expected_audience="mcp", required_scope="agent:invoke")
    assert claims["user"] == "u@example.com"


def test_verify_rejects_token_signed_with_unknown_key(monkeypatch):
    """A token signed with a third key (neither primary nor next) is rejected."""
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", "p" * 32)
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY_NEXT", "n" * 32)
    # Mint with an unrelated key.
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", "x" * 32)
    token = sign_mcp_token(scope="agent:invoke", user="u@example.com", ttl_seconds=60)
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", "p" * 32)
    with pytest.raises(InvalidTokenError):
        verify_mcp_token(token, expected_audience="mcp", required_scope="agent:invoke")


def test_verify_works_with_no_next_key(monkeypatch):
    """When MCP_AUTH_SIGNING_KEY_NEXT is unset, behaviour is identical to single-key mode."""
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", "p" * 32)
    monkeypatch.delenv("MCP_AUTH_SIGNING_KEY_NEXT", raising=False)
    token = sign_mcp_token(scope="agent:invoke", user="u@example.com", ttl_seconds=60)
    claims = verify_mcp_token(token, expected_audience="mcp", required_scope="agent:invoke")
    assert claims["user"] == "u@example.com"
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `.venv/bin/pytest services/mcp_tools/common/tests/test_auth.py::test_verify_accepts_token_signed_with_next_key -xvs`
Expected: FAIL with `InvalidTokenError` (current code only tries primary key).

- [ ] **Step 3: Implement dual-key verify**

In `services/mcp_tools/common/auth.py:verify_mcp_token`, replace the single-key compare block (around line 158-164) with:

```python
primary = os.environ.get("MCP_AUTH_SIGNING_KEY", "")
next_key = os.environ.get("MCP_AUTH_SIGNING_KEY_NEXT", "")
if not primary:
    raise InvalidTokenError("MCP_AUTH_SIGNING_KEY not configured")

def _try(key: str) -> bool:
    expected = hmac.new(key.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest()
    return hmac.compare_digest(expected, signature)

if _try(primary):
    pass  # primary verified
elif next_key and _try(next_key):
    log.info("mcp_auth_verify_via_next_key", extra={"event": "mcp_auth_verify_via_next_key"})
else:
    raise InvalidTokenError("HMAC signature mismatch")
```

Note: the exact variable names (`signing_input`, `signature`) come from the surrounding code at lines 148-160 of the existing `verify_mcp_token`. Read those lines before editing to confirm.

- [ ] **Step 4: Run tests, confirm pass**

Run: `.venv/bin/pytest services/mcp_tools/common/tests/test_auth.py -v`
Expected: all three new tests pass; pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add services/mcp_tools/common/auth.py services/mcp_tools/common/tests/test_auth.py
git commit -m "$(cat <<'EOF'
feat(mcp-auth): MCP_AUTH_SIGNING_KEY_NEXT dual-key verify

Closes BACKLOG.md:67. Tokens signed with either MCP_AUTH_SIGNING_KEY
or MCP_AUTH_SIGNING_KEY_NEXT now verify, enabling zero-downtime
rotation. Mint still uses primary only; rotation procedure:
1. Set _NEXT to new key on all verifiers.
2. Promote _NEXT to primary on signers, sequentially.
3. Clear _NEXT once signers have rolled.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: A6 — TypeScript side dual-key verify

**Files:**
- Modify: `services/agent-claw/src/security/mcp-tokens.ts:145-end` (`verifyMcpToken`)
- Modify: `services/agent-claw/tests/unit/mcp-tokens.test.ts`

The TS-side `verifyMcpToken` is used by the agent process when it acts as a verifier (less common than the Python case, but the contract must match).

- [ ] **Step 1: Write the failing tests**

Add to `services/agent-claw/tests/unit/mcp-tokens.test.ts`:

```ts
describe("verifyMcpToken — dual-key rotation", () => {
  it("accepts a token signed with MCP_AUTH_SIGNING_KEY_NEXT when primary is rotated", () => {
    const primary = "p".repeat(32);
    const next = "n".repeat(32);
    process.env.MCP_AUTH_SIGNING_KEY = next;
    const token = signMcpToken({ scope: "agent:invoke", user: "u@example.com", ttlSeconds: 60 });
    process.env.MCP_AUTH_SIGNING_KEY = primary;
    process.env.MCP_AUTH_SIGNING_KEY_NEXT = next;
    const claims = verifyMcpToken(token, { expectedAudience: "mcp", requiredScope: "agent:invoke" });
    expect(claims.user).toBe("u@example.com");
  });

  it("rejects a token signed with a key that is neither primary nor next", () => {
    process.env.MCP_AUTH_SIGNING_KEY = "x".repeat(32);
    const token = signMcpToken({ scope: "agent:invoke", user: "u@example.com", ttlSeconds: 60 });
    process.env.MCP_AUTH_SIGNING_KEY = "p".repeat(32);
    process.env.MCP_AUTH_SIGNING_KEY_NEXT = "n".repeat(32);
    expect(() =>
      verifyMcpToken(token, { expectedAudience: "mcp", requiredScope: "agent:invoke" }),
    ).toThrow(/signature/i);
  });

  it("behaves identically to single-key mode when MCP_AUTH_SIGNING_KEY_NEXT is unset", () => {
    process.env.MCP_AUTH_SIGNING_KEY = "p".repeat(32);
    delete process.env.MCP_AUTH_SIGNING_KEY_NEXT;
    const token = signMcpToken({ scope: "agent:invoke", user: "u@example.com", ttlSeconds: 60 });
    const claims = verifyMcpToken(token, { expectedAudience: "mcp", requiredScope: "agent:invoke" });
    expect(claims.user).toBe("u@example.com");
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npm test --workspace services/agent-claw -- mcp-tokens.test.ts`
Expected: 2 of 3 fail.

- [ ] **Step 3: Implement dual-key verify**

In `services/agent-claw/src/security/mcp-tokens.ts`, modify `verifyMcpToken` to read both env vars and try `timingSafeEqual` against each:

```ts
const primary = process.env.MCP_AUTH_SIGNING_KEY ?? "";
const nextKey = process.env.MCP_AUTH_SIGNING_KEY_NEXT ?? "";
if (!primary) {
  throw new Error("MCP_AUTH_SIGNING_KEY not configured");
}
const expectedPrimary = createHmac("sha256", primary).update(signingInput).digest();
const sigBuf = Buffer.from(signature, "base64url");
if (sigBuf.length === expectedPrimary.length && timingSafeEqual(sigBuf, expectedPrimary)) {
  // primary verified
} else if (nextKey) {
  const expectedNext = createHmac("sha256", nextKey).update(signingInput).digest();
  if (sigBuf.length !== expectedNext.length || !timingSafeEqual(sigBuf, expectedNext)) {
    throw new Error("HMAC signature mismatch");
  }
  getLogger("McpTokens").info({ event: "mcp_auth_verify_via_next_key" }, "verified via _NEXT key");
} else {
  throw new Error("HMAC signature mismatch");
}
```

(Exact variable names `signingInput`, `signature` and the Buffer/timingSafeEqual primitives come from the existing implementation; preserve them.)

- [ ] **Step 4: Run, confirm pass**

Run: `npm test --workspace services/agent-claw -- mcp-tokens.test.ts`
Expected: all dual-key tests pass; pre-existing tests still pass.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit --project services/agent-claw`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add services/agent-claw/src/security/mcp-tokens.ts services/agent-claw/tests/unit/mcp-tokens.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp-auth): MCP_AUTH_SIGNING_KEY_NEXT dual-key verify (TS side)

TS-side verifier matches Python contract from prior commit.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: A10 — mcp_embedder fail-loud on stub-encoder

**Files:**
- Modify: `services/mcp_tools/mcp_embedder/main.py:28-32` (`_build_encoder`)
- Create: `services/mcp_tools/mcp_embedder/tests/test_fail_loud.py`

- [ ] **Step 1: Check tests directory exists**

Run: `ls services/mcp_tools/mcp_embedder/tests/`
If `tests/` is missing, create it with an empty `__init__.py`. If it exists, proceed.

- [ ] **Step 2: Write failing test**

Create `services/mcp_tools/mcp_embedder/tests/test_fail_loud.py`:

```python
"""Tests for the stub-encoder fail-loud guard in mcp_embedder._build_encoder."""

import importlib
import os
import sys

import pytest


def _reload_main(monkeypatch, model_name: str, dev_mode: str | None):
    monkeypatch.setenv("EMBED_MODEL_NAME", model_name)
    if dev_mode is None:
        monkeypatch.delenv("CHEMCLAW_DEV_MODE", raising=False)
    else:
        monkeypatch.setenv("CHEMCLAW_DEV_MODE", dev_mode)
    # Force re-import so module-level _build_encoder() re-runs with the new env.
    sys.modules.pop("services.mcp_tools.mcp_embedder.main", None)
    sys.modules.pop("services.mcp_tools.mcp_embedder.settings", None)
    return importlib.import_module("services.mcp_tools.mcp_embedder.main")


def test_stub_encoder_refused_outside_dev_mode(monkeypatch):
    """Production deploy with embed_model_name=stub-encoder must refuse to start."""
    with pytest.raises(RuntimeError, match="stub-encoder.*CHEMCLAW_DEV_MODE"):
        _reload_main(monkeypatch, model_name="stub-encoder", dev_mode=None)


def test_stub_encoder_refused_when_dev_mode_false(monkeypatch):
    with pytest.raises(RuntimeError, match="stub-encoder"):
        _reload_main(monkeypatch, model_name="stub-encoder", dev_mode="false")


def test_stub_encoder_allowed_when_dev_mode_true(monkeypatch):
    """CHEMCLAW_DEV_MODE=true is the documented escape hatch."""
    mod = _reload_main(monkeypatch, model_name="stub-encoder", dev_mode="true")
    # If we got here, _build_encoder did not raise.
    assert mod._encoder is not None
```

- [ ] **Step 3: Run test, confirm fail**

Run: `.venv/bin/pytest services/mcp_tools/mcp_embedder/tests/test_fail_loud.py -xvs`
Expected: first two FAIL with no RuntimeError (StubEncoder constructed silently).

- [ ] **Step 4: Modify `_build_encoder`**

Edit `services/mcp_tools/mcp_embedder/main.py:28-32`:

```python
def _build_encoder() -> Encoder:
    if settings.embed_model_name == "stub-encoder":
        dev_mode = os.environ.get("CHEMCLAW_DEV_MODE", "").strip().lower() == "true"
        if not dev_mode:
            raise RuntimeError(
                "mcp_embedder refused to start: embed_model_name='stub-encoder' "
                "outside CHEMCLAW_DEV_MODE=true. Stub embeddings are deterministic "
                "hash-seeded and produce semantically meaningless vectors; allowing "
                "them in production would poison pgvector indexes. Set EMBED_MODEL_NAME "
                "to a real model (e.g. BAAI/bge-m3) or set CHEMCLAW_DEV_MODE=true for "
                "local dev."
            )
        log.warning("Using stub encoder (dev-only — not semantic)")
        return StubEncoder()
    return BGEM3Encoder(settings.embed_model_name, settings.embed_device)
```

Add `import os` at the top if it's not already imported.

- [ ] **Step 5: Run tests, confirm pass**

Run: `.venv/bin/pytest services/mcp_tools/mcp_embedder/tests/ -v`
Expected: all three new tests pass.

- [ ] **Step 6: Commit**

```bash
git add services/mcp_tools/mcp_embedder/main.py services/mcp_tools/mcp_embedder/tests/test_fail_loud.py
git commit -m "$(cat <<'EOF'
feat(mcp-embedder): fail-loud on stub-encoder outside CHEMCLAW_DEV_MODE

Closes BACKLOG.md:290. A misconfigured production deploy with
embed_model_name=stub-encoder now refuses to start, rather than
silently embedding hash-seeded garbage into pgvector indexes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: A7 — recommend_next_batch bumps optimization_campaigns.etag

**Files:**
- Modify: `services/agent-claw/src/tools/builtins/recommend_next_batch.ts:141-272`
- Modify: `services/agent-claw/tests/unit/builtins/optimization_campaign.test.ts`

The current code is already single-txn with `pg_advisory_xact_lock`. The remaining gap: a successful round INSERT does not bump `optimization_campaigns.etag`, so an external consumer holding an etag snapshot cannot detect that a new round landed.

- [ ] **Step 1: Read the current implementation**

Run: `sed -n '141,272p' services/agent-claw/src/tools/builtins/recommend_next_batch.ts`

Confirm the structure: `withUserContext` → `pg_advisory_xact_lock` → SELECT campaign → SELECT rounds → MCP postJson → INSERT optimization_rounds … RETURNING id. We will add an `UPDATE optimization_campaigns SET etag = etag + 1 WHERE id = $1 AND etag = $expected` after the successful INSERT.

- [ ] **Step 2: Write failing test**

Add to `services/agent-claw/tests/unit/builtins/optimization_campaign.test.ts` inside `describe("recommend_next_batch", …)`:

```ts
it("bumps optimization_campaigns.etag after a successful round INSERT", async () => {
  const pool = makeMockPool(); // existing test helper
  // Seed campaign at etag=3, no rounds, valid Domain.
  await pool.query(
    `INSERT INTO optimization_campaigns (id, nce_project_id, domain, etag, status)
     VALUES ($1, $2, $3::jsonb, 3, 'active')`,
    [campaignId, projectId, domainJson],
  );
  await runRecommendNextBatch(/* … existing setup with mocked MCP returning one candidate */);
  const { rows } = await pool.query<{ etag: number }>(
    `SELECT etag FROM optimization_campaigns WHERE id = $1`,
    [campaignId],
  );
  expect(rows[0].etag).toBe(4);
});

it("does not bump etag when the round INSERT raises round_index_conflict", async () => {
  const pool = makeMockPool();
  // Seed two rounds at the same index to trigger ON CONFLICT branch.
  // (Use existing fixture pattern from neighbouring tests.)
  await expect(runRecommendNextBatch(/* … */)).rejects.toThrow(/round_index_conflict/);
  const { rows } = await pool.query<{ etag: number }>(
    `SELECT etag FROM optimization_campaigns WHERE id = $1`,
    [campaignId],
  );
  expect(rows[0].etag).toBe(3); // unchanged
});
```

(Use the actual `makeMockPool` / `runRecommendNextBatch` helpers in the test file — read them at lines 1-275 to confirm names.)

- [ ] **Step 3: Run test, confirm fail**

Run: `npm test --workspace services/agent-claw -- optimization_campaign.test.ts`
Expected: new "bumps etag" test fails (etag stays 3).

- [ ] **Step 4: Add the etag bump in the transaction**

In `recommend_next_batch.ts` between the round INSERT (line ~209) and the txn return, add:

```ts
await client.query(
  `UPDATE optimization_campaigns SET etag = etag + 1, updated_at = NOW() WHERE id = $1`,
  [campaignId],
);
```

Place this AFTER the INSERT … RETURNING block, BEFORE the txn return. The advisory lock at line 142 already serialises concurrent callers.

- [ ] **Step 5: Run tests, confirm pass**

Run: `npm test --workspace services/agent-claw -- optimization_campaign.test.ts`
Expected: new tests pass; pre-existing `recommend_next_batch` tests still pass.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit --project services/agent-claw`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add services/agent-claw/src/tools/builtins/recommend_next_batch.ts \
        services/agent-claw/tests/unit/builtins/optimization_campaign.test.ts
git commit -m "$(cat <<'EOF'
fix(bo): recommend_next_batch bumps optimization_campaigns.etag

Closes BACKLOG.md:14,57. Round INSERT now bumps the campaign's
etag inside the same advisory-lock'd transaction, so a consumer
holding a snapshot can detect that new rounds landed. The
'two-transaction race' framing in the BACKLOG entry was stale;
the surrounding code was already single-txn, but the etag
bookkeeping was the missing piece.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: A8 — advance_synthesis_campaign._claim bumps campaign etag

**Files:**
- Modify: `services/agent-claw/src/tools/builtins/advance_synthesis_campaign.ts:245-252` (claim branch)
- Modify: `services/agent-claw/tests/unit/builtins/synthesis_campaign.test.ts`

The `_claim` step (proposed → in_progress on a step row) is the only state-mutating UPDATE in `advance_synthesis_campaign` that does NOT bump `synthesis_campaigns.etag`. Die, completed, proposed→active all do. This is an asymmetry — fix.

- [ ] **Step 1: Read the current claim branch**

Run: `sed -n '240,260p' services/agent-claw/src/tools/builtins/advance_synthesis_campaign.ts`
Confirm the UPDATE updates `synthesis_campaign_steps`, not the parent `synthesis_campaigns`. The plan adds a second UPDATE on the parent.

- [ ] **Step 2: Write failing test**

Add to `services/agent-claw/tests/unit/builtins/synthesis_campaign.test.ts` inside `describe("advance_synthesis_campaign", …)`:

```ts
it("bumps synthesis_campaigns.etag when claiming a proposed step", async () => {
  const pool = makeMockPool();
  // Seed campaign at etag=5, one proposed step ready to claim.
  await seedActiveCampaignWithProposedStep(pool, campaignId, { etag: 5 });
  await runAdvanceSynthesisCampaign({ campaign_id: campaignId, action: "claim_next_step" });
  const { rows } = await pool.query<{ etag: number }>(
    `SELECT etag FROM synthesis_campaigns WHERE id = $1`,
    [campaignId],
  );
  expect(rows[0].etag).toBe(6);
});
```

(Use the existing test fixtures — read the existing claim-step tests first to match style/helpers.)

- [ ] **Step 3: Run, confirm fail**

Run: `npm test --workspace services/agent-claw -- synthesis_campaign.test.ts -- -t "bumps synthesis_campaigns.etag"`
Expected: FAIL (etag stays 5).

- [ ] **Step 4: Add the etag bump**

In `advance_synthesis_campaign.ts`, after the `_claim` UPDATE on `synthesis_campaign_steps` (currently around lines 245-252), add:

```ts
await client.query(
  `UPDATE synthesis_campaigns SET etag = etag + 1, updated_at = NOW() WHERE id = $1`,
  [campaignId],
);
```

Place inside the existing `SELECT … FOR UPDATE` transaction so it serialises with the other etag bumps.

- [ ] **Step 5: Run tests, confirm pass**

Run: `npm test --workspace services/agent-claw -- synthesis_campaign.test.ts synthesis_campaigns.test.ts`
Expected: new test passes; pre-existing tests still pass (other branches already bumped etag).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit --project services/agent-claw`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add services/agent-claw/src/tools/builtins/advance_synthesis_campaign.ts \
        services/agent-claw/tests/unit/builtins/synthesis_campaign.test.ts
git commit -m "$(cat <<'EOF'
fix(synthesis-campaigns): _claim step bumps synthesis_campaigns.etag

Closes BACKLOG.md:193. The claim branch was the only state-mutating
path in advance_synthesis_campaign that didn't bump the parent
campaign's etag — die/completed/proposed-to-active all did.
Asymmetry resolved.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: A1 — PolicyMatchContext orgId / nceProjectId plumbing (part 1: types)

**Files:**
- Modify: `services/agent-claw/src/core/types.ts:14-72` (`ToolContext`)
- Modify: `services/agent-claw/src/core/permissions/policy-loader.ts:43-48` (`PolicyMatchContext`)
- Modify: `services/agent-claw/src/core/hooks/permission.ts:35-46`

This task ships **type-level** plumbing only; Task 8 wires the construction sites.

- [ ] **Step 1: Extend `ToolContext`**

Edit `services/agent-claw/src/core/types.ts` — add two fields after `userEntraId`:

```ts
export interface ToolContext {
  /** Entra-ID (or dev email) of the calling user; threads RLS. */
  userEntraId: string;
  /**
   * Organisation ID for this call, when known. `null` means the caller
   * has not bound an organisation (e.g. background tasks, tests, legacy
   * routes pre-F.3). Org-scoped permission policies that match this
   * tool's pattern will surface a structured WARN when this is null
   * (see resolver.ts).
   */
  orgId: string | null;
  /**
   * NCE-project ID for this call, when known. Same null semantics as
   * orgId. When set, must be a project the user has access to via
   * user_project_access (RLS is the final authority — this field is
   * advisory for permission policy matching, not access enforcement).
   */
  nceProjectId: string | null;
  // … rest unchanged
}
```

- [ ] **Step 2: Tighten `PolicyMatchContext`**

Edit `services/agent-claw/src/core/permissions/policy-loader.ts:43-48`:

```ts
export interface PolicyMatchContext {
  toolId: string;
  inputJson: string;
  org: string | null;
  project: string | null;
}
```

Required, nullable. No more `?:` shrug.

- [ ] **Step 3: Update `permission.ts` hook to read from typed fields**

Edit `services/agent-claw/src/core/hooks/permission.ts:35-46` — replace the `as { orgId?: string }` cast with direct reads from `payload.ctx.orgId` / `payload.ctx.nceProjectId`:

```ts
const matchCtx: PolicyMatchContext = {
  toolId: payload.toolId,
  inputJson: JSON.stringify(payload.input ?? {}),
  org: payload.ctx.orgId,
  project: payload.ctx.nceProjectId,
};
```

Drop the "Phase F.3" comment that hand-waved the absent fields — now they're real, just often null.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit --project services/agent-claw`
Expected: a flood of errors at the seven `ToolContext` construction sites — that's Task 8.

DO NOT proceed to step 5. The next task fixes the construction sites. We commit Task 7 separately as a typed-contract commit.

- [ ] **Step 5: Stage the type-level changes without compiling**

Since the codebase doesn't compile yet (intended), we can still commit. Confirm only the 3 expected files are dirty:

Run: `git status --porcelain`
Expected: `services/agent-claw/src/core/types.ts`, `services/agent-claw/src/core/permissions/policy-loader.ts`, `services/agent-claw/src/core/hooks/permission.ts`.

- [ ] **Step 6: Commit (will not pass CI alone — paired with Task 8)**

Strategy choice: either commit now and let CI fail on this single commit, or fold Tasks 7 + 8 into one commit. **Preferred: fold.** Skip step 6, continue to Task 8 and commit together.

---

## Task 8: A1 — PolicyMatchContext orgId / nceProjectId plumbing (part 2: construction sites)

**Files (7 sites):**
- Modify: `services/agent-claw/src/routes/chat.ts:172`
- Modify: `services/agent-claw/src/routes/plan.ts:74`
- Modify: `services/agent-claw/src/routes/deep-research.ts:150`
- Modify: `services/agent-claw/src/routes/workflow-sub-agent.ts:123`
- Modify: `services/agent-claw/src/core/chained-harness.ts:208` and `:454`
- Modify: `services/agent-claw/src/core/sub-agent.ts:129`
- Modify: `services/agent-claw/tests/**` — any test that constructs `ToolContext` directly (find via grep)

- [ ] **Step 1: Enumerate production construction sites**

Run: `grep -n "ToolContext\s*=" services/agent-claw/src/core/*.ts services/agent-claw/src/routes/*.ts`
Confirm the 7 sites above. If a new one has appeared, include it.

- [ ] **Step 2: Update each site to default `orgId` and `nceProjectId` to `null`**

For each of the 7 sites, add the two fields to the literal. Example pattern (chat.ts:172):

```ts
const ctx: ToolContext = {
  userEntraId,
  orgId: null,            // Phase F.3 will populate from request body / session binding
  nceProjectId: null,     // same
  seenFactIds,
  scratchpad,
  lifecycle,
};
```

The values are deliberately `null`, not a value parsed from the request. Today none of the routes accept these — that's a separate follow-up (Phase F.3, already on BACKLOG.md:130). Setting them to `null` makes the type compile AND makes the absence intentional, not accidental.

Sub-agent and chained-harness inherit from parent ctx — pass through:

```ts
const subCtx: ToolContext = {
  userEntraId: parentCtx.userEntraId,
  orgId: parentCtx.orgId,
  nceProjectId: parentCtx.nceProjectId,
  // …
};
```

- [ ] **Step 3: Enumerate and fix test sites**

Run: `grep -rn "ToolContext\s*=" services/agent-claw/tests/`
For each hit, add `orgId: null, nceProjectId: null` (or `orgId: "org-test"` etc. in the new A1 deny-fires test from Task 9).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit --project services/agent-claw`
Expected: clean.

- [ ] **Step 5: Run all tests**

Run: `npm test --workspace services/agent-claw`
Expected: no regression vs Task 1's baseline (modulo additions from Task 9 still to come).

- [ ] **Step 6: Commit Tasks 7+8 together**

```bash
git add services/agent-claw/src/core/types.ts \
        services/agent-claw/src/core/permissions/policy-loader.ts \
        services/agent-claw/src/core/hooks/permission.ts \
        services/agent-claw/src/routes/chat.ts \
        services/agent-claw/src/routes/plan.ts \
        services/agent-claw/src/routes/deep-research.ts \
        services/agent-claw/src/routes/workflow-sub-agent.ts \
        services/agent-claw/src/core/chained-harness.ts \
        services/agent-claw/src/core/sub-agent.ts \
        services/agent-claw/tests/
git commit -m "$(cat <<'EOF'
feat(permissions): PolicyMatchContext.org/project become required-nullable

Closes BACKLOG.md:82,130 (infra half). ToolContext gains
orgId/nceProjectId (both string|null); permission.ts reads them
directly instead of the no-op `as { orgId?: string }` cast.
PolicyMatchContext.org/.project change from optional to required-
nullable so an org-scoped policy can no longer silently fail to
fire because the call site forgot to provide context.

Today the 7 construction sites pass null — Phase F.3 will wire
request-body / session-binding population. Task 9 adds the
structured WARN that surfaces this gap in Loki.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: A1 — resolver WARN on org-scoped policy with unbound ctx + matrix tests

**Files:**
- Modify: `services/agent-claw/src/core/permissions/resolver.ts:132-158`
- Modify: `services/agent-claw/tests/unit/permission-policy-aggregation-matrix.test.ts`
- Modify: `services/agent-claw/tests/unit/permission-enforce-mode.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `permission-enforce-mode.test.ts`:

```ts
it("WARNs when an org-scoped policy exists but ctx.orgId is null", async () => {
  const logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const log = makeMemoryLogger(logs); // existing helper or quick stub
  installLogger("PermissionResolver", log);
  // Policy that would deny `risky_tool` for org `acme`.
  await seedPolicy({ scope: "org", scope_id: "acme", decision: "deny", tool_pattern: "risky_tool" });
  const result = await resolver.resolve({
    toolId: "risky_tool",
    input: {},
    ctx: makeCtx({ orgId: null, nceProjectId: null }),
    mode: "enforce",
  });
  // Default fires (ask) because the org policy can't match an unbound ctx.
  expect(result.decision).toBe("ask");
  const warn = logs.find((l) => l.obj.event === "permission_org_scoped_policy_unbound_ctx");
  expect(warn).toBeDefined();
  expect(warn?.obj.policyCount).toBeGreaterThanOrEqual(1);
});

it("the same org-scoped policy DOES fire when ctx.orgId matches", async () => {
  await seedPolicy({ scope: "org", scope_id: "acme", decision: "deny", tool_pattern: "risky_tool" });
  const result = await resolver.resolve({
    toolId: "risky_tool",
    input: {},
    ctx: makeCtx({ orgId: "acme", nceProjectId: null }),
    mode: "enforce",
  });
  expect(result.decision).toBe("deny");
});
```

Add to `permission-policy-aggregation-matrix.test.ts`: extend the matrix with `(ctx.orgId: null | "acme") × (policy.scope: "org" | "global")` rows.

- [ ] **Step 2: Run, confirm fail**

Run: `npm test --workspace services/agent-claw -- permission-enforce-mode.test.ts`
Expected: WARN test FAILs (no log emitted today).

- [ ] **Step 3: Add the WARN emit in resolver.ts**

In `services/agent-claw/src/core/permissions/resolver.ts`, in the enforce-mode no-policy-match path (currently around lines 132-158), before returning the default decision, check whether the loader has any org-scoped policies that COULD have matched if `ctx.orgId` were populated:

```ts
if (ctx.org === null) {
  const orgScopedHits = await this.loader.countMatchableOrgPolicies(toolId);
  if (orgScopedHits > 0) {
    getLogger("PermissionResolver").warn(
      {
        event: "permission_org_scoped_policy_unbound_ctx",
        toolId,
        policyCount: orgScopedHits,
      },
      "org-scoped permission policy could match this tool, but ctx.orgId is null — policy will not fire until route populates orgId (Phase F.3)",
    );
  }
}
// … existing default-decision return
```

Add `countMatchableOrgPolicies(toolId: string): Promise<number>` to the loader. Implementation: iterates the in-memory snapshot, counts policies where `scope === "org"` and `toolPattern` matches `toolId` (use the existing `tool_pattern` matcher with trailing-wildcard support per CLAUDE.md).

- [ ] **Step 4: Run tests, confirm pass**

Run: `npm test --workspace services/agent-claw -- permission-enforce-mode.test.ts permission-policy-aggregation-matrix.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit --project services/agent-claw`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add services/agent-claw/src/core/permissions/resolver.ts \
        services/agent-claw/src/core/permissions/policy-loader.ts \
        services/agent-claw/tests/unit/permission-enforce-mode.test.ts \
        services/agent-claw/tests/unit/permission-policy-aggregation-matrix.test.ts
git commit -m "$(cat <<'EOF'
feat(permissions): WARN when org-scoped policy could match but ctx.orgId is null

Closes BACKLOG.md:82,130 (visibility half). The resolver now emits
`permission_org_scoped_policy_unbound_ctx` when an org-scoped policy
would have matched the tool pattern but the caller's ctx has no
orgId. Loki dashboards can surface a count of these per
deployment to drive the Phase F.3 work.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: A4 — post_tool redact-tool-output hook

**Files:**
- Create: `services/agent-claw/src/core/hooks/redact-tool-output.ts`
- Create: `hooks/redact-tool-output.yaml`
- Modify: `services/agent-claw/src/core/hook-loader.ts` (add to `BUILTIN_REGISTRARS`)
- Modify: `services/agent-claw/src/bootstrap/start.ts` (bump `MIN_EXPECTED_HOOKS` to 26)
- Create: `services/agent-claw/tests/unit/hooks/redact-tool-output.test.ts`

**Why this design:** All post_tool hooks see the output. Scrubbing UNCONDITIONALLY at post_tool time gives defense-in-depth — even a builtin that constructs a response with embedded SMILES (e.g. `propose_retrosynthesis`'s route strings) gets redacted before the model sees the next-turn message. The `redactString` primitive is length-bounded and idempotent, so re-running it on already-clean text is cheap.

- [ ] **Step 1: Write the failing test**

Create `services/agent-claw/tests/unit/hooks/redact-tool-output.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Lifecycle } from "../../../src/core/lifecycle.js";
import { registerRedactToolOutputHook } from "../../../src/core/hooks/redact-tool-output.js";
import type { ToolContext, PostToolPayload } from "../../../src/core/types.js";

function makeCtx(): ToolContext {
  return {
    userEntraId: "u@example.com",
    orgId: null,
    nceProjectId: null,
    scratchpad: new Map(),
    seenFactIds: new Set(),
  };
}

describe("redact-tool-output post_tool hook", () => {
  let lifecycle: Lifecycle;
  beforeEach(() => {
    lifecycle = new Lifecycle();
    registerRedactToolOutputHook(lifecycle);
  });

  it("redacts SMILES embedded in a tool output string field", async () => {
    const payload: PostToolPayload = {
      toolId: "some_tool",
      input: {},
      output: { note: "compound CCCCCCN(C(=O)CCCCCC)CCCCCC was suggested" },
      ctx: makeCtx(),
    };
    await lifecycle.dispatch("post_tool", payload, "tool-use-1");
    expect((payload.output as { note: string }).note).not.toContain("CCCCCC");
    expect((payload.output as { note: string }).note).toContain("[REDACTED:SMILES]");
  });

  it("redacts SMILES in nested arrays of strings", async () => {
    const payload: PostToolPayload = {
      toolId: "some_tool",
      input: {},
      output: { steps: [{ description: "react CCO with CC(=O)O" }] },
      ctx: makeCtx(),
    };
    await lifecycle.dispatch("post_tool", payload, "tool-use-1");
    const steps = (payload.output as { steps: { description: string }[] }).steps;
    expect(steps[0].description).not.toContain("CC(=O)O");
  });

  it("leaves null and number fields untouched", async () => {
    const payload: PostToolPayload = {
      toolId: "some_tool",
      input: {},
      output: { count: 42, name: null, ratio: 0.5 },
      ctx: makeCtx(),
    };
    await lifecycle.dispatch("post_tool", payload, "tool-use-1");
    expect(payload.output).toEqual({ count: 42, name: null, ratio: 0.5 });
  });

  it("is idempotent (already-redacted output passes through unchanged)", async () => {
    const payload: PostToolPayload = {
      toolId: "some_tool",
      input: {},
      output: { note: "uses [REDACTED:SMILES] as a reagent" },
      ctx: makeCtx(),
    };
    await lifecycle.dispatch("post_tool", payload, "tool-use-1");
    expect((payload.output as { note: string }).note).toBe("uses [REDACTED:SMILES] as a reagent");
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npm test --workspace services/agent-claw -- redact-tool-output.test.ts`
Expected: import error (file doesn't exist yet).

- [ ] **Step 3: Create the hook implementation**

Create `services/agent-claw/src/core/hooks/redact-tool-output.ts`:

```ts
import type { Lifecycle, PostToolPayload, HookJSONOutput } from "../types.js";
import { redactString } from "../../observability/redact-string.js";

/**
 * Defense-in-depth post_tool hook. Walks the output object and applies
 * the same length-bounded redactor that scrubs outbound LLM text to
 * every string leaf. Runs unconditionally — applies to all tools
 * (builtins and MCP-backed alike) before the output is handed back
 * to the harness for inclusion in the model's next-turn context.
 *
 * Acceptable to redact MORE than strictly necessary (the agent never
 * NEEDS to see a raw SMILES embedded in a free-text field — chemistry
 * tools return structured fields; literal strings are commentary).
 */
function scrubValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubValue(v);
    }
    return out;
  }
  return value;
}

export function registerRedactToolOutputHook(lifecycle: Lifecycle): void {
  lifecycle.on("post_tool", async (payload: PostToolPayload): Promise<HookJSONOutput> => {
    if (payload.output !== null && typeof payload.output === "object") {
      // Mutate in place — the harness reads payload.output after dispatch.
      (payload as { output: unknown }).output = scrubValue(payload.output);
    } else if (typeof payload.output === "string") {
      (payload as { output: unknown }).output = redactString(payload.output);
    }
    return {};
  });
}
```

- [ ] **Step 4: Create the YAML declaration**

Create `hooks/redact-tool-output.yaml`:

```yaml
name: redact-tool-output
lifecycle: post_tool
enabled: true
order: 50
definition: |
  Defense-in-depth scrub of tool outputs before they enter the LLM
  context. Runs after anti-fabrication, tag-maturity, source-cache
  so fact-ID harvesting / artifact stamping / source-cache write
  see the unredacted output, but the model sees the redacted form.
```

Order 50 places this AFTER the existing post_tool hooks (anti-fabrication, tag-maturity, source-cache — none specify `order`, default 100; we go LOWER to run later in ascending-sort, OR HIGHER — check CLAUDE.md). Per CLAUDE.md: "ascending sort within a phase (default 100; filename tiebreaker)." So order 50 runs FIRST. We want LAST. Use order: 200.

Correction:

```yaml
order: 200
```

- [ ] **Step 5: Register in hook-loader**

Edit `services/agent-claw/src/core/hook-loader.ts` — add to `BUILTIN_REGISTRARS`:

```ts
"redact-tool-output": (lifecycle, _deps) => registerRedactToolOutputHook(lifecycle),
```

Add the import:

```ts
import { registerRedactToolOutputHook } from "./hooks/redact-tool-output.js";
```

- [ ] **Step 6: Bump MIN_EXPECTED_HOOKS**

Edit `services/agent-claw/src/bootstrap/start.ts` — change `MIN_EXPECTED_HOOKS = 25` to `MIN_EXPECTED_HOOKS = 26`. (Confirm current value first; CLAUDE.md says 25 but check the source-of-truth.)

- [ ] **Step 7: Run tests, confirm pass**

Run: `npm test --workspace services/agent-claw -- redact-tool-output.test.ts`
Expected: all 4 pass.

Run: `npm test --workspace services/agent-claw`
Expected: full suite passes (no regression).

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit --project services/agent-claw`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add services/agent-claw/src/core/hooks/redact-tool-output.ts \
        hooks/redact-tool-output.yaml \
        services/agent-claw/src/core/hook-loader.ts \
        services/agent-claw/src/bootstrap/start.ts \
        services/agent-claw/tests/unit/hooks/redact-tool-output.test.ts
git commit -m "$(cat <<'EOF'
feat(security): post_tool redact-tool-output hook (defense-in-depth)

Closes BACKLOG.md:208. Adds a post_tool hook that walks every tool
output (builtin or MCP-backed) and applies the length-bounded
redactor to all string leaves before the harness hands the output
back to the model. Pre-fix, only the outbound LLM text (assistant
final) was scrubbed; raw SMILES / compound codes / NCE-IDs
embedded in tool responses entered the next-turn context.

Ordering: runs last (order: 200) so anti-fabrication / tag-maturity /
source-cache still see the unredacted output for fact-ID harvesting
and artifact stamping. Idempotent — re-running on already-redacted
text is a no-op.

MIN_EXPECTED_HOOKS bumped 25 -> 26.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: BACKLOG rewrite — close items, bounce A9

**Files:**
- Modify: `BACKLOG.md` (lines 67, 82, 130, 14, 57, 193, 208, 212, 290)
- Modify: `CLAUDE.md` if it cites MIN_EXPECTED_HOOKS=25 (it does — search and update).

- [ ] **Step 1: Mark completed items as DONE**

For each of A1, A4, A6, A7, A8, A10, prefix the bullet with `[DONE 2026-05-14]` and a one-line summary of where the fix lives, mirroring the existing DONE-marker style in BACKLOG.md.

Example for A6 (BACKLOG.md:67):

```
- [DONE 2026-05-14] [security/mcp-auth] dual-key `MCP_AUTH_SIGNING_KEY` / `MCP_AUTH_SIGNING_KEY_NEXT` verify in `services/mcp_tools/common/auth.py:verify_mcp_token` and `services/agent-claw/src/security/mcp-tokens.ts:verifyMcpToken`. Mint always uses primary. Rotation runbook (`docs/runbooks/rotate-mcp-auth-key.md`) needs a follow-up rewrite to drop the maintenance-window 401 language — tracked as a separate bullet below.
```

Add a follow-up entry under the existing item:

```
- [docs/runbooks/rotate-mcp-auth-key] rewrite to use the new MCP_AUTH_SIGNING_KEY_NEXT dual-key flow (zero downtime) instead of single-key maintenance-window rotation.
```

Do the same for A1, A4, A7, A8, A10 with their respective file references.

- [ ] **Step 2: Rewrite A9 with the design question**

Replace BACKLOG.md:212 with:

```
- [agent-claw/idempotency] `tag-maturity.ts:117-143` INSERT INTO `artifacts` and `propose_hypothesis.ts:60-79` INSERT INTO `hypotheses` cannot use `ON CONFLICT DO UPDATE` today because neither table has a natural-key UNIQUE constraint. Design question: what is the dedup key per table? Candidates: artifacts `(tool_id, sha256(payload::text), owner_entra_id)`; hypotheses `(scope_nce_project_id, sha256(hypothesis_text), proposed_by_user_entra_id)`. Each candidate has trade-offs — e.g. should re-proposing the same hypothesis text by a different user be a duplicate or a separate row? Pick a policy in a 1-page ADR before adding the unique constraint + ON CONFLICT clauses.
```

- [ ] **Step 3: Update CLAUDE.md MIN_EXPECTED_HOOKS reference**

Run: `grep -n "MIN_EXPECTED_HOOKS" CLAUDE.md`
For each hit, bump from 25 to 26 (or whatever the new floor is per Task 10).

- [ ] **Step 4: Commit**

```bash
git add BACKLOG.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(backlog): close Tranche 1 items; rewrite A9 with design question

Marks A1, A4, A6, A7, A8, A10 as DONE 2026-05-14. Rewrites
the artifacts/hypotheses idempotency bullet with the natural-key
design question that needs an ADR. Bumps MIN_EXPECTED_HOOKS
references from 25 to 26 in CLAUDE.md.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Full pre-PR verification

- [ ] **Step 1: Full TS test suite**

Run: `npm test --workspace services/agent-claw`
Expected: ≥1497 passed (baseline), new tests added by Tasks 2–10 also pass.

- [ ] **Step 2: TS typecheck**

Run: `npx tsc --noEmit --project services/agent-claw`
Expected: clean.

- [ ] **Step 3: Python tests for changed surfaces**

Run: `.venv/bin/pytest services/mcp_tools/common/tests/test_auth.py services/mcp_tools/mcp_embedder/tests/ -v`
Expected: all pass.

- [ ] **Step 4: Confirm no untracked files left behind**

Run: `git status --porcelain`
Expected: empty.

- [ ] **Step 5: Confirm commit count**

Run: `git log --oneline main..HEAD`
Expected: 7 commits (Tasks 2, 3, 4, 5, 6, 7+8 merged, 9, 10, 11) — confirm count matches plan execution.

---

## Task 13: PR + review loop

- [ ] **Step 1: Push branch**

```bash
git push -u origin claude/tranche-1-security-fixes
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(security): Tranche 1 — close 6 security/correctness gaps" --body "$(cat <<'EOF'
## Summary

Closes 6 items from BACKLOG.md identified in the 2026-05-14 tranche-1 review:

- **A1** — `PolicyMatchContext.org/.project` become required-nullable; `ToolContext` gains typed `orgId`/`nceProjectId`; resolver WARNs when org-scoped policies exist but ctx is unbound (visibility for Phase F.3)
- **A4** — new `redact-tool-output` post_tool hook (defense-in-depth scrub of MCP/builtin tool outputs before LLM context)
- **A6** — `MCP_AUTH_SIGNING_KEY_NEXT` dual-key verify on both Python (`services/mcp_tools/common/auth.py`) and TS (`services/agent-claw/src/security/mcp-tokens.ts`) sides; enables zero-downtime rotation
- **A7** — `recommend_next_batch` bumps `optimization_campaigns.etag` on round INSERT
- **A8** — `advance_synthesis_campaign._claim` bumps `synthesis_campaigns.etag` (resolves asymmetry with other state-mutating branches)
- **A10** — `mcp_embedder._build_encoder` raises at boot when `embed_model_name='stub-encoder'` outside `CHEMCLAW_DEV_MODE=true`

Bounces **A9** back to BACKLOG with a design question (natural-key choice for artifacts/hypotheses `ON CONFLICT`).

## Plan

`docs/plans/2026-05-14-tranche-1-security-fixes.md`

## Test plan

- [ ] Full TS suite passes (`npm test --workspace services/agent-claw`)
- [ ] TS typecheck clean (`npx tsc --noEmit --project services/agent-claw`)
- [ ] Python auth + embedder tests pass (`pytest services/mcp_tools/common/tests/test_auth.py services/mcp_tools/mcp_embedder/tests/`)
- [ ] New tests cover each item (see commits per-task)
- [ ] CI green
- [ ] `/review` clean (will run automatically against this branch)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Watch CI to green**

Run: `gh pr checks --watch`
Expected: all checks green.

If a check fails, diagnose root cause — do NOT bypass. Real failures land as fixup commits to the same branch.

- [ ] **Step 4: Run /review on the agent's own PR**

Per CLAUDE.md rule #2: "the agent runs `/review` on its own PR and iterates via fixup commits to the same branch until the review comes back clean".

```bash
# /review is a user-facing slash; agent invokes via the code-review skill or the gh CLI workflow.
gh pr view --json number --jq .number  # capture PR number
```

Then trigger the review skill (`code-review:code-review`) targeting this PR. Iterate on any findings.

- [ ] **Step 5: Merge**

When CI is green AND `/review` returns clean:

```bash
PR_NUMBER=$(gh pr view --json number --jq .number)
gh pr merge $PR_NUMBER --merge
```

- [ ] **Step 6: Cleanup**

```bash
git checkout main
git pull origin main
git branch -D claude/tranche-1-security-fixes
git push origin --delete claude/tranche-1-security-fixes || \
  echo "Remote delete failed (HTTP 403 from proxy is a known issue — BACKLOG.md:136,278); GitHub auto-delete-on-merge may handle it"
```

---

## Self-Review

**Spec coverage**: A1 ✓ (Tasks 7-9), A4 ✓ (Task 10), A6 ✓ (Tasks 2-3), A7 ✓ (Task 5), A8 ✓ (Task 6), A10 ✓ (Task 4), A9 bounced with note ✓ (Task 11). All six in-scope items have task coverage.

**Placeholder scan**: One callout in Task 10 step 4 ("Order 50 places this AFTER... Correction: Use order: 200") — that's a self-correction documented inline, not a placeholder. Acceptable.

**Type consistency**: `orgId`/`nceProjectId` field names match across `ToolContext`, the 7 construction sites, and the test helper `makeCtx`. `PolicyMatchContext.org`/`.project` (resolver-facing names, shorter) intentionally differ — Task 8 step 3 documents the mapping in `permission.ts`.

**Test design**: each item has TDD (test-first) except Task 7 (pure type-level change — typecheck is the test) and Task 11 (docs).

---

## Execution choice

Plan complete and saved to `docs/plans/2026-05-14-tranche-1-security-fixes.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because tasks are mostly independent (each closes one BACKLOG item).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Tighter feedback loop, but consumes context.

Which approach?
