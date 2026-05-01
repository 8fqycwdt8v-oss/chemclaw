# Runbook: Rotate `MCP_AUTH_SIGNING_KEY`

The HS256 signing key that mints/verifies MCP service Bearer tokens (ADR
006 Layer 2). Rotating it without downtime is a two-phase operation
because every MCP service AND the agent must accept both keys during the
window.

## Threat model

Compromise of the signing key lets an attacker mint MCP tokens for any
user → can call any MCP tool. Rotate immediately on suspected leak;
otherwise rotate every 90 days as routine hygiene.

## Prerequisites

- Helm + kubectl access to the production cluster, OR docker-compose
  shell on the host.
- Private key access to update the secret.

## Phase A — stage the new key

1. Generate the new key:
   ```bash
   NEW_KEY="$(openssl rand -hex 32)"
   ```

2. Update the secret to hold BOTH keys (old as primary, new as fallback):
   ```bash
   kubectl create secret generic chemclaw-mcp-auth-key \
     --from-literal=signing_key="$OLD_KEY" \
     --from-literal=signing_key_next="$NEW_KEY" \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

   The agent and MCP services both look at `signing_key_next` (when set)
   in addition to `signing_key`. Tokens minted with EITHER key validate.

3. Roll the agent + every MCP service so they pick up `signing_key_next`:
   ```bash
   kubectl rollout restart deploy/agent-claw
   for svc in mcp-rdkit mcp-drfp mcp-kg mcp-embedder mcp-tabicl \
              mcp-doc-fetcher mcp-eln-local mcp-logs-sciy; do
     kubectl rollout restart deploy/$svc
   done
   ```

   Wait for `kubectl rollout status` to report ready on each.

4. Verify the agent is signing with the OLD key but every MCP accepts
   either:
   ```bash
   ./scripts/smoke.sh
   ```

## Phase B — promote the new key

1. Swap the secret so the new key is primary:
   ```bash
   kubectl create secret generic chemclaw-mcp-auth-key \
     --from-literal=signing_key="$NEW_KEY" \
     --from-literal=signing_key_next="$OLD_KEY" \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

2. Restart the agent only (signing source). MCP services continue to
   validate either key:
   ```bash
   kubectl rollout restart deploy/agent-claw
   ```

3. Run smoke again.

## Phase C — revoke the old key

1. Wait at least one full session-budget reset window (default 24h) so
   no in-flight resume continuations carry the old key.

2. Drop the fallback:
   ```bash
   kubectl create secret generic chemclaw-mcp-auth-key \
     --from-literal=signing_key="$NEW_KEY" \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

3. Roll the agent + MCP services again so they forget the old key.

4. Burn the old key from your password manager / vault.

## Audit

- Phase A → C should each generate a `secret-rotation` event in your
  observability platform (Helm chart annotation `audit-event=secret-rotation`).
- Append an entry to your team's secret-rotation log with date + initiator.

## Rollback

If anything breaks during Phase B (LLM calls returning 401), revert the
secret to the Phase A state and roll back. Old tokens stay valid for the
session-budget window so users see no interruption.
