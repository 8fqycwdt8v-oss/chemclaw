# Runbook: Rotate `MCP_AUTH_SIGNING_KEY`

The HS256 signing key that mints/verifies MCP service Bearer tokens (ADR
006 Layer 2).

## Threat model

Compromise of the signing key lets an attacker mint MCP tokens for any
user → can call any MCP tool. Rotate immediately on suspected leak;
otherwise rotate every 90 days as routine hygiene.

## Current limitation: single-key rotation only

The agent and MCP services accept exactly one `MCP_AUTH_SIGNING_KEY` —
there is **no dual-key (`signing_key` + `signing_key_next`) support
today**. A naive rotation produces a brief window during which existing
tokens fail validation. Two acceptable shapes:

- **Brief-downtime rotation** (this runbook): roll the secret + restart
  agent and every MCP service together. In-flight requests during the
  rollout get 401s and clients retry. Acceptable for a maintenance
  window.
- **Dual-key rotation** (BACKLOG): implement an `MCP_AUTH_SIGNING_KEY_NEXT`
  fallback in `services/mcp_tools/common/auth.py:_verify_token` so a
  receiver accepts EITHER key during the rollout. Tracked as a follow-up.

If this is a suspected-leak rotation and the brief downtime is
unacceptable, file an emergency change with the on-call to coordinate.
Otherwise:

## Prerequisites

- Helm + kubectl access to the production cluster, OR docker-compose
  shell on the host.
- Private key access to update the secret.
- Maintenance window scheduled (typically <60s of 401s during the agent
  + MCP service rollout).

## Procedure

1. Generate the new key:
   ```bash
   NEW_KEY="$(openssl rand -hex 32)"
   ```

2. Update the secret:
   ```bash
   kubectl create secret generic chemclaw-mcp-auth-key \
     --from-literal=signing_key="$NEW_KEY" \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

3. Roll the agent + every MCP service so they pick up the new key:
   ```bash
   kubectl rollout restart deploy/agent-claw
   for svc in mcp-rdkit mcp-drfp mcp-kg mcp-embedder mcp-tabicl \
              mcp-doc-fetcher mcp-eln-local mcp-logs-sciy; do
     kubectl rollout restart deploy/$svc
   done
   ```

   Wait for `kubectl rollout status` to report ready on each. Existing
   tokens minted with the old key get 401s during the window between
   "agent restarts" and "every MCP service restarts" — clients retry.

4. Verify with smoke:
   ```bash
   ./scripts/smoke.sh
   ```

5. Burn the old key from your password manager / vault.

## Audit

- Generates a `secret-rotation` event in your observability platform
  (Helm chart annotation `audit-event=secret-rotation`).
- Append an entry to your team's secret-rotation log with date + initiator.

## Rollback

If `smoke.sh` fails after step 4, revert the secret to the prior key and
re-run step 3:

```bash
kubectl create secret generic chemclaw-mcp-auth-key \
  --from-literal=signing_key="$OLD_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deploy/agent-claw
# (and the same for-loop on MCP services)
```
