# Runbook: Forged-tool lifecycle

The agent can synthesise its own Python tools at runtime via `forge_tool`.
Once forged, a tool moves through a multi-stage lifecycle before it's
trusted enough to run unattended for users at scale. This runbook is the
end-to-end map.

It exists for two audiences:

- **Operators** investigating "where did this tool come from / why did it
  get auto-disabled / can I promote it now?"
- **New contributors** trying to understand the synthesis path before
  changing it.

## File map

| File | Role |
|---|---|
| `services/agent-claw/src/tools/builtins/forge_tool.ts` | The 4-stage Forjador pipeline (analyze → generate → execute → evaluate). Inserts `skill_library` + `tools` rows on all-pass. |
| `services/agent-claw/src/tools/builtins/induce_forged_tool_from_trace.ts` | Generalises a Langfuse trace into test cases and delegates to `forge_tool`. |
| `services/agent-claw/src/tools/builtins/add_forged_tool_test.ts` | Lets the agent (or an operator) append a regression test to a forged tool. RLS-scoped to the forged-tool owner. |
| `services/optimizer/forged_tool_validator/runner.py` | Nightly cron (02:00 UTC) that re-runs every active forged tool's `forged_tool_tests` and writes `forged_tool_validation_runs`. Auto-disables on `status='failing'`. |
| `services/optimizer/forged_tool_validator/validator.py` | The actual validator (sandboxed `run_program` per test case). |
| `services/optimizer/forged_tool_validator/sandbox_client.py` | Sandbox abstraction (LocalSubprocess in dev; E2B in prod). |
| `db/init/*` | `skill_library`, `forged_tool_tests`, `forged_tool_validation_runs` schemas. |

## The five lifecycle stages

```
   [forge / induce] → SHADOW → VALIDATING → ACTIVE → (FORK | DEPRECATE)
                                    ↘
                                    AUTO-DISABLED
```

### 1. Forge / induce — the agent calls `forge_tool` or `induce_forged_tool_from_trace`

What happens:
- 4-stage Forjador pipeline runs in-line:
  1. **Analyze** — Zod-validate the proposed input/output schemas + the
     two-to-ten test cases. Reject name conflicts against existing tools
     and against the loop-guard list (`forge_tool`, `run_program`).
  2. **Generate** — call LiteLLM (model role per `forged_by_role`,
     default `forge`) with the spec + implementation hint. Output is
     Python source.
  3. **Execute** — for each test case, run the generated code through
     the sandbox (`SandboxClient`) with the test input. E2B in prod;
     local subprocess in dev.
  4. **Evaluate** — diff actual vs expected outputs (with optional
     per-test `tolerance`).

Persistence (only on **all-pass**):
- `skill_library` row: `kind='forged_tool'`, `active=false`,
  `shadow_until=NOW()+14 days`, `parent_tool_id` set when forking,
  `version` = parent.version+1 (or 1 for new tools).
- `tools` row: `source='forged'`, `enabled=true`.
- Python code on disk at `$FORGED_TOOLS_DIR/<uuid>.py`.

On any-fail: nothing persisted; failure list returned. The agent can
retry with a different implementation hint.

### 2. SHADOW — `active=false`, `shadow_until > NOW()`

The default 14-day window. The tool is loaded by the registry but not
selectable for production calls. Two ways to graduate:

- **Wait it out**: the nightly validator (next stage) treats a tool as
  "candidate for promotion" once `shadow_until <= NOW()` AND its
  validation history is clean.
- **Manual early promotion**: operators can flip
  `skill_library.active=true` ahead of `shadow_until` if they trust
  the tool. Document the bypass via `appendAudit`.

### 3. VALIDATING — nightly cron at 02:00 UTC

`services/optimizer/forged_tool_validator/runner.py` walks every
`skill_library` row with `kind='forged_tool' AND active=true`,
re-runs every `forged_tool_tests` row through the sandbox, and writes
one `forged_tool_validation_runs` row per tool.

Outcome states (in `validation_runs.status`):

| Status | Meaning | Action |
|---|---|---|
| `passing` | All tests pass. | No-op; tool stays active. |
| `degraded` | Some tests pass, some fail (≥ 50% pass rate). | WARN logged; tool stays active. Operator should investigate. |
| `failing` | < 50% pass rate. | **Auto-disabled**: `UPDATE skill_library SET active=false`. |

Immediate-on-startup behaviour: `runner.py` calls `run_validation()`
once at boot so the first nightly result is not delayed.

### 4. ACTIVE — `active=true`, `shadow_until` expired, validation passing

The tool is selectable by `apply-skills` and callable by the agent like
any builtin. RLS-scoped reads/writes apply via the calling user's
context.

### 5. FORK / DEPRECATE

Two terminal-ish states:

- **Fork**: an operator (or the agent) calls `forge_tool` again with
  `parent_tool_id=<existing_uuid>`. The new tool gets `version =
  parent.version + 1` and re-enters SHADOW. The parent stays active
  unless explicitly deprecated.
- **Deprecate**: `UPDATE skill_library SET active=false` — same flag
  the auto-disable path uses; flip manually when retiring an old
  version after the fork has matured.

## Operator playbook

### "A forged tool just got auto-disabled — what do I do?"

```sql
-- See the failure
SELECT id, run_at, total_tests, passed, failed, status, errors_json
  FROM forged_tool_validation_runs
 WHERE forged_tool_id = '<uuid>'
 ORDER BY run_at DESC
 LIMIT 5;
```

The `errors_json` carries one entry per failing test: which
`test_case_id` failed, the observed output, and the diff vs expected.
Decide:

- **Test was wrong**: edit / remove the test via
  `add_forged_tool_test` (or direct SQL on `forged_tool_tests` if
  you're the tool owner). Re-enable manually.
- **Tool drifted with an upstream change** (LLM model, MCP schema,
  …): fork via `forge_tool { parent_tool_id, … }` to land a new
  version that handles the new contract.
- **Tool is fundamentally unsafe**: leave disabled; document the
  reason in `BACKLOG.md`.

### "I need to promote a SHADOW tool right now"

```sql
UPDATE skill_library
   SET active = true, shadow_until = NOW()
 WHERE id = '<uuid>' AND kind = 'forged_tool';
```

Then file an `appendAudit` entry on the action so the global_admin
audit log carries the override.

### "I need to bulk-deprecate every v1 of a forged tool that has a v2"

```sql
WITH newer AS (
  SELECT parent_tool_id
    FROM skill_library
   WHERE kind = 'forged_tool' AND parent_tool_id IS NOT NULL
)
UPDATE skill_library s
   SET active = false
  FROM newer n
 WHERE s.id = n.parent_tool_id
   AND s.active = true;
```

### "I need to disable forged tools entirely"

Add a permission policy denying `forged:*`:

```bash
curl -X POST -H "x-user-entra-id: $YOU" \
  -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "scope_id": "",
    "decision": "deny",
    "tool_pattern": "forged:*",
    "reason": "incident IR-2026-XX-XX: pausing forged-tool execution"
  }' \
  http://localhost:3101/api/admin/permission-policies
```

This is the "kill switch" — leaves the database intact but blocks
runtime selection. Hot (60s); reversible (DELETE the policy).

## Open gaps (BACKLOG)

These were identified in the 2026-05-10 deep review and are tracked
in `BACKLOG.md`:

- Weak-from-strong transfer / cross-tenant scope promotion logic for
  forks (`parent_tool_id`-driven version chains exist; the promotion
  rules between tenants are not codified).
- Chemistry-domain validation hooks at forge-time (no SMILES
  canonicalisation in the test executor; a forged `rank_ligands` tool
  gets a generic JSON contract).

## Related runbooks

- `docs/runbooks/disable-tool.md` — three-layer kill-switch pattern.
- `docs/runbooks/autonomy-upgrade.md` — when forging is allowed at
  what autonomy tier.
- `docs/runbooks/harness-rollback.md` — emergency rollback if a
  forged-tool execution path destabilises the harness itself.
