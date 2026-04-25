# Runbook — Harness Rollback

Use this runbook to revert any Phase A–F primitive without downtime.

---

## 1. Disable a feature flag in the hook layer

Hook YAML files live in `hooks/`. To disable a hook:

```bash
# Edit the hook file:
vim hooks/source-cache.yaml
# Set: enabled: false
# Then restart agent-claw:
docker compose restart agent-claw   # or kubectl rollout restart deploy/agent-claw
```

All hooks check `enabled: true` at startup; no code change required.

---

## 2. Roll back a prompt

Prompts are stored in `prompt_registry` with versioned rows. To revert:

```sql
-- List active prompts:
SELECT name, version, active, shadow_until FROM prompt_registry ORDER BY name, version;

-- Deactivate the candidate; promote the previous version:
UPDATE prompt_registry SET active = false WHERE name = 'agent.system' AND version = 3;
UPDATE prompt_registry SET active = true  WHERE name = 'agent.system' AND version = 2;
```

The `PromptRegistry` cache TTL is 60 s. After 60 s (or an explicit `invalidate()`
call) the agent picks up the change without a restart.

---

## 3. Replay a projector from scratch

Projectors are idempotent. To force a full rebuild of a derived view:

```bash
# Example: replay the kg_source_cache projector
psql "$PG_URL" -c "DELETE FROM projection_acks WHERE projector_name = 'kg_source_cache';"
# Restart the projector so it re-processes all unacked events:
docker compose restart kg-source-cache
```

Available projector names: `chunk_embedder`, `reaction_vectorizer`, `kg_experiments`,
`kg_hypotheses`, `contextual_chunker`, `kg_source_cache`.

---

## 4. Disable a forged tool

```sql
UPDATE skill_library
SET active = false
WHERE name = '<forged_tool_name>' AND kind = 'forged_tool';
```

The tool registry re-reads `skill_library` at each turn start (or on TTL expiry).
No restart needed.

---

## 5. Revert a schema migration

Schema migrations are additive (ALTER TABLE ADD COLUMN IF NOT EXISTS). To roll back:

```sql
-- Example: remove source-cache event type (if needed):
DELETE FROM ingestion_events WHERE event_type = 'source_fact_observed';
DELETE FROM projection_acks WHERE projector_name = 'kg_source_cache';
```

Never DROP a column without confirming no live code reads it. Use a two-phase
approach (deprecate → confirm → drop) for column removals.

---

## 6. Roll back agent-claw to a previous image

```bash
# Kubernetes:
kubectl set image deploy/agent-claw agent-claw=chemclaw/agent-claw:<previous-tag>
# Docker Compose:
AGENT_CLAW_IMAGE=chemclaw/agent-claw:<previous-tag> docker compose up -d agent-claw
```

The previous image shares the same Postgres schema (migrations are additive), so
rollback does not require a DB migration reversal.
