# Runbook: Rotate `MCP_AUTH_SIGNING_KEY`

The HS256 signing key that mints/verifies MCP service Bearer tokens (ADR
006 Layer 2).

## Threat model

Compromise of the signing key lets an attacker mint MCP tokens for any
user → can call any MCP tool. Rotate immediately on suspected leak;
otherwise rotate every 90 days as routine hygiene.

## Dual-key zero-downtime rotation (default flow)

The agent (`services/agent-claw/src/security/mcp-tokens.ts:verifyMcpToken`)
and every MCP service (`services/mcp_tools/common/auth.py:verify_mcp_token`)
accept tokens signed under EITHER `MCP_AUTH_SIGNING_KEY` (primary) or
`MCP_AUTH_SIGNING_KEY_NEXT` (rotation fallback). Mint always uses
primary. The verifier emits a structured INFO log
`mcp_auth_verify_via_next_key` whenever it falls through to `_NEXT`
— operators chart this in Loki to know when every service has rolled.

A length guard rejects misconfigured short keys: `MCP_AUTH_SIGNING_KEY_NEXT`
shorter than 32 chars is treated as unset, with a structured WARN
`mcp_auth_next_key_too_short` so the misconfig is visible in Loki rather
than silently widening the verifier to brute-forceable HMACs.

### Procedure

#### 1. Generate the new key

```bash
NEW_KEY="$(openssl rand -hex 32)"
```

The `openssl rand -hex 32` invocation produces a 64-char hex string
(256 bits); both verifiers enforce `>= 32 chars` so this is safely above
the floor.

#### 2. Stage `_NEXT` on every verifier

Set `MCP_AUTH_SIGNING_KEY_NEXT=$NEW_KEY` on the agent AND every MCP
service WITHOUT touching the primary `MCP_AUTH_SIGNING_KEY`. Roll each
deployment to pick it up.

```bash
kubectl create secret generic chemclaw-mcp-auth-key \
  --from-literal=signing_key="$OLD_KEY" \
  --from-literal=signing_key_next="$NEW_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deploy/agent-claw
for svc in mcp-rdkit mcp-drfp mcp-kg mcp-embedder mcp-tabicl \
           mcp-doc-fetcher mcp-eln-local mcp-logs-sciy; do
  kubectl rollout restart deploy/$svc
done
```

After this step, every verifier accepts tokens signed under either key.
Mint is unchanged (still uses primary). No 401 window.

#### 3. Promote `_NEXT` to primary on signers

Sequentially update the signers (today: agent-claw and any service that
mints — currently only agent-claw mints; the optimizer reanimator
re-uses agent-claw's mint). Swap the secret so the new key becomes
primary, then roll:

```bash
kubectl create secret generic chemclaw-mcp-auth-key \
  --from-literal=signing_key="$NEW_KEY" \
  --from-literal=signing_key_next="$OLD_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deploy/agent-claw
```

Newly-minted tokens now use the new key. Verifiers accept either —
in-flight tokens minted under `$OLD_KEY` (now in `_NEXT`) still verify.

Watch `mcp_auth_verify_via_next_key` in Loki: as the in-flight tokens
expire, the per-second rate of fallback verifications drops to zero.
Default token TTL is 5 minutes (configurable via `MCP_AUTH_TTL_SECONDS`),
so wait at least one TTL after the signer roll before step 4.

#### 4. Clear `_NEXT` on every verifier

Once `mcp_auth_verify_via_next_key` log volume is steady at zero (or
acceptably close), drop the fallback:

```bash
kubectl create secret generic chemclaw-mcp-auth-key \
  --from-literal=signing_key="$NEW_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deploy/agent-claw
for svc in mcp-rdkit mcp-drfp mcp-kg mcp-embedder mcp-tabicl \
           mcp-doc-fetcher mcp-eln-local mcp-logs-sciy; do
  kubectl rollout restart deploy/$svc
done
```

After this step, only `$NEW_KEY` verifies. The rotation is complete.

#### 5. Verify

```bash
./scripts/smoke.sh
```

Confirm a fresh agent → MCP request round-trips. Then burn `$OLD_KEY`
from your password manager / vault.

## Audit

- Generates a `secret-rotation` event in your observability platform
  (Helm chart annotation `audit-event=secret-rotation`).
- The `mcp_auth_verify_via_next_key` INFO log line (during steps 2–4)
  is itself the audit trail: a Grafana panel keyed on this event lets
  you observe every verifier's handover behaviour through the rotation
  window.
- Append an entry to your team's secret-rotation log with date,
  initiator, and which step triggered each rollout.

## Rollback

The dual-key path makes rollback safe at every step.

- **Failure during step 2 (`_NEXT` rollout)**: revert by removing
  `signing_key_next` from the secret + rolling. Verifiers fall back to
  single-key behaviour. Zero downtime.
- **Failure during step 3 (signer promotion)**: revert by swapping the
  secret back (`signing_key="$OLD_KEY"`, `signing_key_next="$NEW_KEY"`)
  and rolling the signers. Tokens minted by the rolled-forward agent
  during the failed window still verify because `$NEW_KEY` is in
  `_NEXT`. Zero downtime.
- **Failure during step 4 (`_NEXT` clear)**: re-add `signing_key_next`
  and roll. The in-flight tokens minted under `$OLD_KEY` (which step 4
  removed support for) get 401s briefly until you complete the rollback.

## Single-key emergency rotation

If the signing key is known compromised and you need to invalidate ALL
existing tokens immediately (not just stop minting new ones under the
old key), skip the dual-key procedure: roll only `signing_key="$NEW_KEY"`
with no `_NEXT`. Every in-flight token under `$OLD_KEY` gets 401 on the
next request, and clients re-mint via the auth flow. Brief downtime
window during the agent + MCP service rollout (typically <60s of 401s).

## See also

- ADR 006 (`docs/adr/006-mcp-bearer-token-auth.md`) — the layered auth
  model.
- `services/mcp_tools/common/auth.py` — Python verifier (the dual-key
  + length-guard logic).
- `services/agent-claw/src/security/mcp-tokens.ts` — TypeScript verifier +
  mint.
- `BACKLOG.md` `[security/mcp-auth]` — open follow-ups.
