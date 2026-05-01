# Runbook: Manage redaction patterns

The LiteLLM redactor scrubs sensitive substrings from outbound prompts.
Phase 3 of the configuration concept added a DB-backed `redaction_patterns`
table that merges with the hardcoded baseline in
`services/litellm_redactor/redaction.py`.

## When to add a pattern

- Tenant uses a compound-code prefix not covered by the global pattern
  (e.g. `ABC-\d{5,7}` instead of the default `CMP-\d{4,8}`).
- New project-id format that should never reach the LLM.
- Custom internal identifier that surfaced in a Langfuse trace.

## Add a pattern

```bash
curl -X POST -H "x-user-entra-id: $YOU" \
  -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "scope_id": "",
    "category": "COMPOUND_CODE",
    "pattern_regex": "\\bABC-\\d{5,7}\\b",
    "flags_re_i": true,
    "description": "ACME compound prefix"
  }' \
  "$AGENT_BASE_URL/api/admin/redaction-patterns"
```

### Required: bounded quantifiers

The DB CHECK enforces `length(pattern_regex) ≤ 200`. The application
loader (`services/litellm_redactor/dynamic_patterns.py:is_pattern_safe`)
ALSO refuses patterns containing unbounded `.*`, `.+`, `\S+`, `\w+`,
`\d+`, `\D+`, `\W+`. Use bounded forms:

| Don't | Do |
|---|---|
| `foo.*bar` | `foo.{0,200}bar` |
| `\w+@\w+` | `\w{1,32}@\w{1,253}` |

Reason: catastrophic backtracking on adversarial input is a soft DoS
vector in the LiteLLM hot path.

## Toggle a pattern off

```bash
# Find the id
curl -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/redaction-patterns" | jq

curl -X PATCH -H "x-user-entra-id: $YOU" \
  -H "content-type: application/json" \
  -d '{"enabled": false, "reason": "false positives flagged by user"}' \
  "$AGENT_BASE_URL/api/admin/redaction-patterns/$ID"
```

## Delete

```bash
curl -X DELETE -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/redaction-patterns/$ID"
```

The deletion writes a `redaction_pattern.delete` audit row.

## Test a candidate pattern locally

```python
from services.litellm_redactor.dynamic_patterns import is_pattern_safe
from services.litellm_redactor.redaction import redact

ok, why = is_pattern_safe(r"\bABC-\d{5,7}\b")
print("safe:", ok, why)

# After inserting via the admin API and waiting 60s for the cache:
print(redact("see ABC-12345 in the report").text)
# → "see <COMPOUND_CODE_…> in the report"
```

## Verify a redaction is firing in production

In Langfuse, search for prompts with `<COMPOUND_CODE_` placeholders. If
your custom pattern's category has a `<{CATEGORY}_{hash}>` placeholder
appearing in production traces, it's working.

## Tenant-scoped patterns

`scope='org'` rows are loaded but NOT YET applied per call — the LiteLLM
gateway lacks the caller's org context (Phase F.3 will add this). For now
prefer global patterns; tenant-specific rows are stored for the future
plumbing.

## Rollback

`PATCH enabled=false` or `DELETE` — both effective within 60s (cache TTL).
Hardcoded patterns stay so a complete table wipe still leaves baseline
SMILES / email / NCE / CMP redaction working.
