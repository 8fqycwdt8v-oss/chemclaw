# Runbook: Disable a misbehaving tool

Three layers, listed in the order you should reach for them.

## 1. Permission policy (recommended; per-scope, audited, hot)

Add a `deny` rule to `permission_policies` (Phase 3). Effective within
60s; auditable; per-scope.

```bash
curl -X POST -H "x-user-entra-id: $YOU" \
  -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "scope_id": "",
    "decision": "deny",
    "tool_pattern": "mcp__github__create_pr",
    "reason": "incident IR-2026-04-30: tool emitted secrets in arguments",
    "audit_reason": "blocking until fix lands"
  }' \
  "$AGENT_BASE_URL/api/admin/permission-policies"
```

`tool_pattern` supports trailing wildcards (`mcp__github__*`).

To re-enable later:

```bash
# List to find the id
curl -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/permission-policies" | jq

# Toggle
curl -X PATCH -H "x-user-entra-id: $YOU" \
  -H "content-type: application/json" \
  -d '{"enabled": false, "audit_reason": "fix shipped"}' \
  "$AGENT_BASE_URL/api/admin/permission-policies/$ID"
```

## 2. Tool registry (legacy; global only)

For tools registered via the `tools` table (built-in, MCP, forged):

```sql
UPDATE tools SET enabled = false WHERE id = '<tool-id>';
```

Effective on the next agent restart (the tool registry isn't hot-reloaded
yet — Phase 2's hot-reload covers skills only).

## 3. Forged-tool disable

For forged tools specifically, `/api/forged-tools/:id/disable` flips
`skill_library.active = false` and is owner-or-admin gated:

```bash
curl -X POST -H "x-user-entra-id: $YOU" \
  -H "content-type: application/json" \
  -d '{"reason": "broken validation runs"}' \
  "$AGENT_BASE_URL/api/forged-tools/$TOOL_ID/disable"
```

## Diagnosis: which tool is misbehaving?

- Check Langfuse traces for the failing turns; the tool id appears in
  every tool_call span.
- Check `model_call_logs` for raw error text.
- Check `forged_tool_validation_runs` for forged-tool failure rate trends.

## Rollback

- `permission_policies` row: PATCH `enabled=false` or DELETE.
- `tools.enabled`: re-flip to `true` and restart agent.
- Forged tool: re-enable via `UPDATE skill_library SET active = true WHERE id = …`.
