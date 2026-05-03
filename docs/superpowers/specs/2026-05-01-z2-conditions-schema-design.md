# Z2 Design — First-Class Condition Columns + `conditions_normalizer` Projector

**Date:** 2026-05-01
**Plan reference:** `~/.claude/plans/develop-an-extensive-plan-distributed-backus.md` (Phase Z2)
**Builds on:** Z0 (PR #64, merged) — Z1 (PR #71, open) is independent of this work.

## Context

Z0 wired the ASKCOS condition recommender; Z1 added applicability-domain + green-chemistry signals around it. Both layers presume the agent can *read* historical reaction conditions out of in-house data — but today the `reactions` table has no condition columns. Conditions live as freetext in `experiments.procedure_text` and as flexible JSONB in `experiments.tabular_data`. The mock ELN seed has structured fields per OFAT campaign in `mock_eln.entries.fields_jsonb`. `statistical_analyze.ts` reaches into the JSONB at query time.

Z2 promotes conditions to first-class columns on `reactions` and ships a projector that fills them. This is the foundation Z3's per-project yield baseline and Z5's BoFire optimizer both depend on.

## Design choices (decided during brainstorming)

| Question | Decision |
|---|---|
| Extraction strategy | **Deterministic-first, LLM fallback.** Three tiers: tabular_data / mock_eln.fields_jsonb direct copy → bounded regex over procedure_text → LiteLLM-via-Haiku for the residual. Each tier only fills slots that earlier tiers left null. |
| Failure handling | **Leave column null + per-field `extraction_status` JSONB.** Status values: `extracted` / `absent` / `ambiguous`. Each carries `source` (tabular_data / mock_eln_fields_jsonb / regex / llm / none) and a timestamp. |
| Projector trigger | **Listen on existing `experiment_imported` event** alongside `reaction_vectorizer`. Zero new event types, zero new triggers. |
| Backfill strategy | **Startup catch-up replay via `BaseProjector`.** Idempotent UPDATE (COALESCE + JSONB merge). Runbook: `DELETE FROM projection_acks WHERE projector_name='conditions_normalizer'` re-derives. |

## Architecture

### Schema additions — `db/init/20_conditions_schema.sql`

Slot 19 is held by Z0/Z1's `19_reaction_optimization.sql`; Z2 takes slot 20.

All columns nullable, all additive. No readers broken. RLS inherited from existing `reactions` policy (FORCE ROW LEVEL SECURITY scoped via the project chain).

```sql
ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS solvent              TEXT,
  ADD COLUMN IF NOT EXISTS solvent_smiles       TEXT,
  ADD COLUMN IF NOT EXISTS catalyst_smiles      TEXT,
  ADD COLUMN IF NOT EXISTS ligand_smiles        TEXT,
  ADD COLUMN IF NOT EXISTS base                 TEXT,
  ADD COLUMN IF NOT EXISTS temperature_c        NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS time_min             NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS pressure_atm         NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS atmosphere           TEXT,
  ADD COLUMN IF NOT EXISTS stoichiometry_json   JSONB,
  ADD COLUMN IF NOT EXISTS conditions_extracted_from TEXT
       CHECK (conditions_extracted_from IS NULL OR
              conditions_extracted_from IN
              ('tabular_data','mock_eln_fields_jsonb','regex','llm','none')),
  ADD COLUMN IF NOT EXISTS extraction_status    JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_reactions_solvent     ON reactions (solvent)        WHERE solvent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_temp        ON reactions (temperature_c)  WHERE temperature_c IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_extracted   ON reactions (conditions_extracted_from);
```

`extraction_status` shape (per-field provenance, OECD principle 5):

```json
{
  "solvent":         { "status": "extracted", "source": "mock_eln_fields_jsonb", "extracted_at": "2026-05-01T..." },
  "catalyst_smiles": { "status": "extracted", "source": "regex" },
  "temperature_c":   { "status": "extracted", "source": "llm", "model": "claude-haiku-4-5" },
  "ligand_smiles":   { "status": "absent" },
  "base":            { "status": "ambiguous", "source": "regex", "candidates": ["K2CO3","Cs2CO3"] }
}
```

### `conditions_normalizer` projector

Location: `services/projectors/conditions_normalizer/`. Subclass of `BaseProjector` from `services/projectors/common/base.py`. Connects as `chemclaw_service` (BYPASSRLS — projector-class write surface). Declares:

```python
name = "conditions_normalizer"
interested_event_types = ("experiment_imported",)
```

Same lifecycle as `reaction_vectorizer`: startup catch-up replay → LISTEN/NOTIFY steady state. Independent of `reaction_vectorizer` — neither depends on the other's output.

#### Three-tier extraction pipeline

For each `experiment_imported` event:

1. **Tier 1 — direct JSONB copy** (`source: 'tabular_data'` or `'mock_eln_fields_jsonb'`).
   - Read `experiments.tabular_data` and (when in mock mode) `mock_eln.entries.fields_jsonb`.
   - Map well-known keys: `solvent`, `catalyst_smiles`, `ligand_smiles`, `base`, `temp_c`/`temperature_c`, `time_min`, `pressure_atm`, `atmosphere`, `equivalents`/`stoichiometry`.
   - Solvent SMILES canonicalized via `mcp_rdkit /canonicalize_smiles`.
   - O(1) per call; no LLM.

2. **Tier 2 — bounded regex over procedure_text** (`source: 'regex'`). Only fills slots Tier 1 left null.
   - Every quantifier explicit-bounded (per CLAUDE.md catastrophic-backtracking rule). Examples:
     - `r"\b(at|to|reflux\s+at)\s+(?P<temp>-?\d{1,3}(?:\.\d{1,2})?)\s*°?C\b"`
     - `r"\((?P<load>\d{1,3}(?:\.\d{1,2})?)\s*mol\s*%\)"`
     - `r"\b(?P<time>\d{1,3})\s*(?:h|hours?|min|minutes?)\b"`
     - `r"\b(?:under|in)\s+(?P<atm>N2|Ar|argon|nitrogen|air|O2)\b"`
   - Solvent matching against an in-memory list (~30 names) loaded at startup.
   - Capped at `MAX_PROCEDURE_TEXT_LEN = 100_000` chars; everything past that is dropped.

3. **Tier 3 — LiteLLM-Haiku fallback** (`source: 'llm'`). Runs only if at least one slot is still null AND `procedure_text` length ≥ 50 chars.
   - LiteLLM call with `AGENT_MODEL_COMPACTOR` (Haiku); 200-token JSON-extraction system prompt; user payload truncated to 8k chars.
   - Pre-egress redaction via existing `services/litellm_redactor/` callback (no new path).
   - Output validated by Pydantic. Validation failure → slot stays null, status `'ambiguous'`.
   - Gated by `CONDITIONS_NORMALIZER_LLM_FALLBACK` env var (default `'true'` in dev, `'false'` until first prod soak).
   - Prompt-cache hit on replay (LiteLLM-side cache) → near-zero replay cost.

#### Persisting the result

One UPDATE per reaction, idempotent via COALESCE + JSONB merge:

```sql
UPDATE reactions
   SET solvent              = COALESCE(solvent,              $1),
       solvent_smiles       = COALESCE(solvent_smiles,       $2),
       catalyst_smiles      = COALESCE(catalyst_smiles,      $3),
       ligand_smiles        = COALESCE(ligand_smiles,        $4),
       base                 = COALESCE(base,                 $5),
       temperature_c        = COALESCE(temperature_c,        $6),
       time_min             = COALESCE(time_min,             $7),
       pressure_atm         = COALESCE(pressure_atm,         $8),
       atmosphere           = COALESCE(atmosphere,           $9),
       stoichiometry_json   = COALESCE(stoichiometry_json,   $10),
       conditions_extracted_from = COALESCE(conditions_extracted_from, $11),
       extraction_status    = extraction_status || $12::jsonb
 WHERE id = $13
```

Re-running against an already-populated row is a no-op (COALESCE on the columns; `||` merges only new keys into `extraction_status`). Replay-safe per BaseProjector contract.

### Consumer updates — minimal and additive

**`statistical_analyze.ts`**: SQL fragment changes from `e.tabular_data->>'solvent'` to `COALESCE(r.solvent, e.tabular_data->>'solvent')`, etc. Fallback path stays for any reaction the projector hasn't normalized yet AND for ingestion sources we don't fully cover. No interface change to the builtin's input/output schemas.

**`find_similar_reactions.ts`**: gains optional structured filters. `{rxn_smiles, k, rxno_class, min_yield_pct, solvent?: string}` — when `solvent` is set, adds `AND ($solvent::text IS NULL OR r.solvent = $solvent)` to the SQL. No behavior change when the new params are absent.

**No other consumers update in Z2.** Z3's yield baseline and Z5's BoFire optimizer will read the structured columns from day one.

## Data flow

```
USER imports an experiment
  ▼
canonical INSERT into experiments + reactions (existing path, unchanged)
  ▼
ingestion_events row {event_type: 'experiment_imported', source_row_id: experiment_id}
  ▼  NOTIFY
LISTEN-ers (concurrent, independent):
  ├─ reaction_vectorizer       → writes reactions.drfp_vector  (existing)
  └─ conditions_normalizer     → writes reactions.solvent / catalyst_smiles / ... + extraction_status  (NEW)

Agent reads:
  statistical_analyze.compare_conditions:
      SELECT COALESCE(r.solvent, e.tabular_data->>'solvent') AS solvent, ...
      (structured column wins; JSONB fallback for un-normalized rows)
```

## Error handling

| Failure | Behavior |
|---|---|
| Corrupted JSONB in tabular_data | Log warn, fall through to regex tier |
| Regex pattern matches nothing | Slot null, `extraction_status[field] = {status: 'absent'}` |
| LLM timeout / 5xx | Slot null, status `'ambiguous'` with `error: 'timeout'`. **Event NOT acked** → retried on next NOTIFY (transient LiteLLM outage gets re-attempted) |
| LLM returns malformed JSON | Pydantic validation fails, slot null, event not acked |
| `mcp_rdkit /canonicalize_smiles` fails | Write un-canonicalized SMILES, status source `'tabular_data_uncanonicalized'` |
| RegEx catastrophic backtracking | Cannot happen by construction (every quantifier bounded); MAX_PROCEDURE_TEXT_LEN cap is defense-in-depth |
| Projector crashes mid-event | No ack → next startup catch-up replays; UPDATE is idempotent |
| User runs `DELETE FROM projection_acks WHERE projector_name='conditions_normalizer'` | Replay from start. Idempotent. Standard runbook. |

## Testing strategy

### Three test layers

1. **Pure-function unit tests** — `services/projectors/conditions_normalizer/tests/test_extractors.py`. No DB, no LLM, no network. ≥ 15 tests covering tabular_data extraction, regex extraction with edge cases (catastrophic-input bound test included), invalid JSONB tolerance, missing-field handling.

2. **Projector integration test** — `services/projectors/conditions_normalizer/tests/test_main.py`. Uses the existing testcontainer Postgres harness shared with the other projectors. Seeds 3 mixed-shape experiments, inserts events, runs one cycle, asserts column population + `extraction_status` shape + ack rows. Replays the cycle and asserts UPDATE was a no-op (idempotency).

3. **`statistical_analyze.test.ts` regression** — TS-side. Add fixture rows with structured-only / JSONB-only / both-populated states; assert COALESCE precedence (structured wins).

### LLM mocking

LLM tier mocked via `vi.stubGlobal('fetch', ...)` returning canned LiteLLM responses. No real LLM calls during CI.

### Backfill smoke (manual, post-deploy)

Run against the seeded mock_eln (~2000 reactions). Expected distribution:
- > 80% `conditions_extracted_from = 'mock_eln_fields_jsonb'` (Tier 1)
- ~10% `'regex'`
- ~5% `'llm'`
- residual `'none'`

Numbers logged via the projector's existing telemetry.

## Risks & mitigations

- **LLM cost during initial backfill**: ~2000 reactions × 13% LLM rate × Haiku rate ≈ $0.20–$0.50 first-time. Steady-state near zero. Bounded.
- **Schema drift during backfill window**: COALESCE in consumer SQL means readers continue to work even if some rows are normalized and some aren't. No deploy-order constraint between schema migration, projector deploy, and consumer update.
- **Projector latency under load**: ~50 ms (Tier 1) to ~3 s (Tier 3) per event. Worst case 100 events queued → 5 min drain. Acceptable for a non-user-facing path; can be parallelized via `asyncio.gather` later if needed.
- **Mock-vs-real ELN drift**: Tier 1's `mock_eln.entries.fields_jsonb` source is gated by an `if mock_eln schema exists` check. Production ELN naturally falls through to Tiers 2/3. Same code, dev and prod.
- **LLM-fallback default off in prod**: env var `CONDITIONS_NORMALIZER_LLM_FALLBACK=false` initially; flip to `true` after first soak. Defense against unexpected LLM cost spikes.

## Out of scope (explicitly)

- **Per-project condition-frequency analysis** — different feature.
- **A `conditions_normalized_at` index** for pulling all unprocessed rows — not needed; ack-based replay covers it.
- **Updating `kg_experiments` to project condition properties as Neo4j attributes** — tracked, but Z6's KG-projection refresh picks them up later.
- **Refactoring all `experiments.tabular_data` callers across the codebase** — out of scope. Only `statistical_analyze` and `find_similar_reactions` (the immediate Z3 readers).

## File-level deliverables

### New
- `db/init/20_conditions_schema.sql` — schema additions + indexes
- `services/projectors/conditions_normalizer/__init__.py`
- `services/projectors/conditions_normalizer/main.py` — projector entry, ≤ 250 LOC
- `services/projectors/conditions_normalizer/extractors.py` — three-tier pure functions, ≤ 350 LOC
- `services/projectors/conditions_normalizer/llm_prompt.py` — Pydantic schema + LiteLLM call
- `services/projectors/conditions_normalizer/requirements.txt`
- `services/projectors/conditions_normalizer/Dockerfile`
- `services/projectors/conditions_normalizer/tests/__init__.py`
- `services/projectors/conditions_normalizer/tests/test_extractors.py` — pure-function unit tests
- `services/projectors/conditions_normalizer/tests/test_main.py` — projector integration test (Docker-gated)
- `services/projectors/conditions_normalizer/tests/fixtures/` — golden inputs

### Modified
- `services/agent-claw/src/tools/builtins/statistical_analyze.ts` — `COALESCE(r.solvent, e.tabular_data->>'solvent')` SQL; no schema change
- `services/agent-claw/src/tools/builtins/find_similar_reactions.ts` — optional `solvent` filter param
- `services/agent-claw/tests/unit/builtins/statistical_analyze.test.ts` — add structured/JSONB/both fixtures
- `services/agent-claw/tests/unit/builtins/find_similar_reactions.test.ts` — assert filter behavior
- `docker-compose.yml` — register `conditions-normalizer` on the existing projectors profile
- `Makefile` — add the new requirements file to `setup.python`

### Reused (no modification)
- `services/projectors/common/base.py` — `BaseProjector` parent
- `services/projectors/reaction_vectorizer/` — reference precedent for an `experiment_imported` listener
- `services/litellm_redactor/` — pre-egress redaction in the LLM-tier path
- `db/init/01_schema.sql` — `experiments`, `reactions`, `ingestion_events`, `projection_acks` (read-only)

## Verification (end-to-end)

```bash
# infra
make up.full       # all services including the new projector
make ps            # confirm conditions-normalizer is healthy

# data
make db.init       # idempotent; new 20_*.sql applies
make db.seed       # seeds mock_eln; experiment_imported events fire

# unit + integration
.venv/bin/pytest services/projectors/conditions_normalizer/tests/ -v
cd services/agent-claw && npm test     # statistical_analyze + find_similar_reactions regressions

# replay smoke
psql -c "DELETE FROM projection_acks WHERE projector_name='conditions_normalizer';"
docker restart chemclaw-conditions-normalizer
# Watch the catch-up replay log; confirm > 80% mock_eln rows tier1, ~10% tier2, ~5% tier3.

# integration (manual, post-deploy)
chemclaw chat "What's the typical solvent for Buchwald-Hartwig in our project XYZ-001?"
# Expected: structured `r.solvent` column powers the answer; lookup is fast.
```

## Why this design is right

- **Additive only.** No harness change, no hook change, no permission change, no new event type. The projector is a sibling of `reaction_vectorizer`; the schema additions are a single ALTER TABLE on nullable columns.
- **Layered honestly.** Each extraction tier carries its own provenance into `extraction_status` so future readers can audit *which signal* gave each value. OECD principle 5 (mechanistic interpretation) carried through.
- **Failure-safe.** Every Z2 failure mode degrades to an existing path: structured columns null, JSONB fallback in `statistical_analyze` carries through. Replay is idempotent by construction.
- **Cost-bounded.** LLM only fires on the residual ~13% of mock_eln entries Tier 1 + Tier 2 don't cover. Backfill cost is ~$0.50; steady-state near zero.
- **Forward-compatible.** Z3's yield baseline and Z5's BoFire optimizer get to read structured columns from day one. The COALESCE-with-JSONB-fallback consumer pattern means no deploy-order coupling either.
