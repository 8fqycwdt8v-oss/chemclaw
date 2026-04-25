# ADR 006: Sandbox network isolation + MCP service authentication

**Status:** proposed
**Date:** 2026-04-25
**Driver:** post-v1.0.0-claw security audit (finding C5 / Harness #3)

## Context

The agent harness exposes a `run_program` tool that executes LLM-authored
Python in an E2B sandbox. The sandbox is given a stub library (`chemclaw.*`)
that resolves at first call to in-cluster URLs for the MCP services
(`http://mcp-kg:8003`, `http://mcp-doc-fetcher:8006`, etc.). Two compounding
problems came out of the audit:

1. **Network egress is advisory only.** `services/agent-claw/src/core/sandbox.ts`
   sets `CHEMCLAW_NO_NET=1` as an env var inside the sandbox, with a comment
   stating "actual blocking is enforced at E2B template level." There is no
   runtime verification that the E2B template `python-3-11` actually denies
   egress. By default, E2B sandboxes have unrestricted internet.
2. **MCP services have no authentication.** Direct HTTP calls from the
   sandbox to `http://mcp-kg:8003/...` succeed without any caller identity.
   This means LLM-generated Python can:
   - Bypass every harness hook (`anti-fabrication`, `foundation-citation-guard`,
     `source-cache`, `redact-secrets`) by side-channeling the parent agent
     and going straight to the MCP services.
   - Read/write across the agent's normal RLS scope (the MCP services run as
     `chemclaw_service` with BYPASSRLS).

The combination is the highest-impact finding in the audit because it
enables prompt-injection-driven exfiltration and citation laundering.

## Decision (target state)

**Replace the advisory env-var with a two-layer enforced boundary:**

### Layer 1: network namespace lockdown via custom E2B template

Build a custom E2B template `chemclaw-python-sandbox` whose firewall
denies all egress except to a specific allow-list of MCP hostnames on
specific ports. The template config:

```dockerfile
FROM e2bdev/code-interpreter:python
# iptables OUTPUT rules: drop all except agent's egress proxy.
RUN apt-get update && apt-get install -y iptables ca-certificates
COPY chemclaw-firewall.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/chemclaw-firewall.sh
ENTRYPOINT ["/usr/local/bin/chemclaw-firewall.sh"]
```

The firewall script:
- DROP all OUTPUT.
- ACCEPT loopback.
- ACCEPT only the parent agent's egress proxy at a fixed CIDR.

`SANDBOX_ALLOW_NET_EGRESS=true` is then renamed to mean "allow egress to
the agent's egress proxy specifically" — never to the public internet.

### Layer 2: MCP service authentication

Every MCP service requires a `Authorization: Bearer <token>` header.
Tokens are short-lived (5-minute TTL), per-sandbox, and signed by the
agent's HMAC key. The token payload:

```json
{
  "sub": "<sandbox_id>",
  "user": "<userEntraId>",
  "scope": ["mcp_kg:read", "mcp_doc_fetcher:read"],
  "exp": <unix-ts>
}
```

The agent injects `CHEMCLAW_MCP_TOKEN=<jwt>` into the sandbox env at
creation, and the stub library reads it on every call. MCP services
verify the token, log the sandbox_id, and apply the user_entra_id to
RLS context. Any direct call without a valid token returns 401.

### Layer 3: hook re-injection for sandbox MCP calls

When the sandbox calls e.g. `chemclaw.query_kg(...)`, the request is
proxied back through the parent agent (over a stdin/stdout RPC channel)
so the parent's lifecycle hooks fire as if the agent had made the call
itself. This is the part that closes the citation/source-cache hole:
sandbox-originated tool calls become indistinguishable from agent-originated
ones at the lifecycle layer.

## Consequences

- Per-sandbox JWT mint requires an HMAC key in the agent. Add a Kubernetes
  secret `chemclaw-mcp-signing-key` (32 bytes random); rotate quarterly.
- Each MCP service gains middleware to validate the JWT. Token verification
  adds ~0.5ms per request.
- The custom E2B template adds ~30s to template build time; deploy via
  GitHub Actions on changes to `infra/e2b/template/`.
- Existing forged tools that called MCP services directly via the stub
  library will still work — only the underlying transport changes. The
  stub library wraps the JWT-bearing call.

## Interim mitigations (in v1.0.0-claw)

- `services/agent-claw/src/core/sandbox.ts`: env var renamed
  `SANDBOX_MAX_NET_EGRESS` → `SANDBOX_ALLOW_NET_EGRESS` (with fallback
  for migration). This is purely cosmetic — the underlying enforcement
  is unchanged.
- `run_program` should remain disabled by default in shared environments
  (`SANDBOX_ALLOW_NET_EGRESS=false`) until this ADR is implemented.
- Add a startup health check: refuse to register `run_program` if
  `SANDBOX_ALLOW_NET_EGRESS=true` and `MCP_AUTH_ENABLED=false`.

## Out of scope

- Hardware-level isolation (gVisor, firecracker) — covered by E2B's
  underlying VM model already. We only need the firewall.
- Per-MCP-call audit log to a separate sink — Langfuse OTel spans cover
  this; if that becomes insufficient, a follow-up ADR can add a tamper-
  evident audit log.

## Status

Implementation is staged behind a feature flag. Until the layers above
land, treat the audit finding as live: do not enable `run_program` in
multi-tenant deployments.
