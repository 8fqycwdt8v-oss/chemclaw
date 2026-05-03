# Z2 Conditions Schema + `conditions_normalizer` Projector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote reaction conditions to first-class columns on the `reactions` table and ship a 3-tier projector that fills them from existing `experiments.tabular_data` / mock_eln.entries.fields_jsonb / `procedure_text`, with per-field provenance.

**Architecture:** New schema (additive ALTER TABLE in `20_conditions_schema.sql`); new `conditions_normalizer` projector (subclass of `BaseProjector`, listens on the existing `experiment_imported` event alongside `reaction_vectorizer`); 3-tier extraction (tabular_data direct copy → bounded regex → LiteLLM-Haiku fallback). Each tier only fills slots earlier tiers left null; per-field `extraction_status` JSONB records source + status. Consumer SQL uses `COALESCE(r.solvent, e.tabular_data->>'solvent')` so the JSONB fallback covers the backfill window seamlessly.

**Tech Stack:** Python 3.11 / psycopg / pydantic / pydantic-settings / litellm (existing patterns); RDKit for SMILES canonicalization (via `mcp-rdkit`); TypeScript / Zod / Vitest (consumer-side updates).

**Spec:** `docs/superpowers/specs/2026-05-01-z2-conditions-schema-design.md`

---

## Task 1: Schema migration `20_conditions_schema.sql`

**Files:**
- Create: `db/init/20_conditions_schema.sql`

- [ ] **Step 1: Write the schema file**

```sql
-- Phase Z2 — first-class condition columns on `reactions`.
--
-- Z0 wired the ASKCOS recommender; Z1 added AD + green-chemistry signals.
-- Both layers presume the agent can read historical reaction conditions out of
-- in-house data, but until now `reactions` has no condition columns: conditions
-- live as freetext in `experiments.procedure_text` and as flexible JSONB in
-- `experiments.tabular_data`. This migration promotes them to first-class
-- columns, populated by the new `conditions_normalizer` projector.
--
-- All columns are nullable + additive — no readers broken. Existing JSONB-backed
-- callers continue to work via COALESCE fallback in the consumer SQL.
--
-- Re-applicable: IF NOT EXISTS guards everywhere; the projector backfills via
-- `DELETE FROM projection_acks WHERE projector_name='conditions_normalizer'`.

BEGIN;

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
  ADD COLUMN IF NOT EXISTS conditions_extracted_from TEXT,
  ADD COLUMN IF NOT EXISTS extraction_status    JSONB NOT NULL DEFAULT '{}'::jsonb;

-- conditions_extracted_from is a closed enum; add the CHECK separately so
-- IF NOT EXISTS column-add is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname  = 'reactions_conditions_extracted_from_check'
       AND conrelid = 'reactions'::regclass
  ) THEN
    ALTER TABLE reactions
      ADD CONSTRAINT reactions_conditions_extracted_from_check
      CHECK (conditions_extracted_from IS NULL OR
             conditions_extracted_from IN
             ('tabular_data','mock_eln_fields_jsonb','regex','llm','none'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reactions_solvent
  ON reactions (solvent) WHERE solvent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_temp
  ON reactions (temperature_c) WHERE temperature_c IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_extracted
  ON reactions (conditions_extracted_from);

COMMIT;
```

- [ ] **Step 2: Re-apply schema; verify idempotency**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-conditions-schema-z2
make db.init  # re-applies all init files; should be a clean no-op for existing rows
psql -d chemclaw -c "\d reactions" | grep -E "solvent|catalyst_smiles|temperature_c|extraction_status"
```

Expected: each new column appears once.

- [ ] **Step 3: Verify extraction_status default**

```bash
psql -d chemclaw -c "INSERT INTO reactions (experiment_id) SELECT id FROM experiments LIMIT 1 RETURNING extraction_status;"
```
Expected: `{}` (empty JSONB object).

- [ ] **Step 4: Re-run init twice in a row; expect zero churn**

```bash
make db.init && make db.init
```
Expected: both runs complete without errors; no DDL re-issued (PostgreSQL no-ops on IF NOT EXISTS).

- [ ] **Step 5: Commit**

```bash
git add db/init/20_conditions_schema.sql
git commit -m "feat(z2): schema — first-class condition columns on reactions"
```

---

## Task 2: Projector skeleton

**Files:**
- Create: `services/projectors/conditions_normalizer/__init__.py`
- Create: `services/projectors/conditions_normalizer/main.py`
- Create: `services/projectors/conditions_normalizer/requirements.txt`
- Create: `services/projectors/conditions_normalizer/tests/__init__.py`
- Create: `services/projectors/conditions_normalizer/tests/test_skeleton.py`

- [ ] **Step 1: Write the failing skeleton test**

```python
# services/projectors/conditions_normalizer/tests/test_skeleton.py
"""Skeleton-level tests for the conditions_normalizer projector."""
from __future__ import annotations


def test_projector_class_metadata():
    from services.projectors.conditions_normalizer.main import (  # noqa: PLC0415
        ConditionsNormalizer,
    )
    assert ConditionsNormalizer.name == "conditions_normalizer"
    assert ConditionsNormalizer.interested_event_types == ("experiment_imported",)


def test_projector_settings_defaults():
    from services.projectors.conditions_normalizer.main import Settings  # noqa: PLC0415
    s = Settings(_env_file=None)
    assert s.mcp_rdkit_url.startswith("http")
    assert s.conditions_normalizer_llm_fallback in (True, False)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_skeleton.py -v
```
Expected: ImportError — module does not exist.

- [ ] **Step 3: Implement skeleton**

```python
# services/projectors/conditions_normalizer/__init__.py
```
(empty)

```python
# services/projectors/conditions_normalizer/main.py
"""conditions_normalizer — promote reaction conditions to first-class columns.

Subscribes to `experiment_imported` events. For each reaction in the experiment,
runs a 3-tier extraction (tabular_data direct copy → bounded regex → LiteLLM
fallback) over the experiments.procedure_text + experiments.tabular_data +
mock_eln.entries.fields_jsonb sources, and writes the structured columns plus
per-field extraction_status to the reactions row.

Idempotent: COALESCE on each column + JSONB merge on extraction_status make
re-running over an already-populated row a no-op. Standard replay runbook:
DELETE FROM projection_acks WHERE projector_name='conditions_normalizer'.
"""
from __future__ import annotations

import logging
from typing import Any

from pydantic_settings import SettingsConfigDict

from services.projectors.common.base import BaseProjector, ProjectorSettings

log = logging.getLogger("projector.conditions_normalizer")


class Settings(ProjectorSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    mcp_rdkit_url: str = "http://localhost:8001"
    conditions_normalizer_llm_fallback: bool = True
    litellm_base_url: str = "http://localhost:4000"
    litellm_api_key: str = ""
    agent_model_compactor: str = "claude-haiku-4-5"


class ConditionsNormalizer(BaseProjector):
    name = "conditions_normalizer"
    interested_event_types = ("experiment_imported",)

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self._settings = settings

    async def handle(
        self,
        event_id: Any,
        event_type: str,
        source_table: str | None,
        source_row_id: Any,
        payload: dict[str, Any],
    ) -> None:
        # Filled in Task 7. Skeleton no-op for now.
        return None
```

```
# services/projectors/conditions_normalizer/requirements.txt
psycopg[binary]>=3.2
pydantic>=2.8
pydantic-settings>=2.4
httpx>=0.27
litellm>=1.60
```

```python
# services/projectors/conditions_normalizer/tests/__init__.py
```
(empty)

- [ ] **Step 4: Run tests; expect pass**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_skeleton.py -v
```
Expected: 2 passed.

- [ ] **Step 5: Add the new requirements to Makefile**

Edit `Makefile` `setup.python` block. After the `mcp_drfp/requirements.txt` line:

```makefile
	$(PIP) install -r services/projectors/conditions_normalizer/requirements.txt
```

Place it next to the other `services/projectors/*/requirements.txt` lines.

```bash
.venv/bin/pip install -r services/projectors/conditions_normalizer/requirements.txt
```

- [ ] **Step 6: Commit**

```bash
git add services/projectors/conditions_normalizer/ Makefile
git commit -m "feat(z2): conditions_normalizer projector skeleton"
```

---

## Task 3: Tier 1 — tabular_data / mock_eln direct copy

**Files:**
- Create: `services/projectors/conditions_normalizer/extractors.py`
- Create: `services/projectors/conditions_normalizer/tests/test_extractors_tier1.py`

- [ ] **Step 1: Write the failing tier-1 tests**

```python
# services/projectors/conditions_normalizer/tests/test_extractors_tier1.py
"""Tier 1 (direct JSONB copy) extraction tests."""
from __future__ import annotations

import pytest


def test_tier1_extracts_solvent_and_temp():
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(
        tabular_data={"solvent": "EtOH", "temp_c": 80, "time_min": 240},
        mock_eln_fields={},
    )
    assert out["solvent"] == "EtOH"
    assert out["temperature_c"] == 80.0
    assert out["time_min"] == 240.0
    assert out["_status"]["solvent"] == {"status": "extracted", "source": "tabular_data"}
    assert out["_status"]["temperature_c"] == {"status": "extracted", "source": "tabular_data"}


def test_tier1_mock_eln_fallback_when_tabular_empty():
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(
        tabular_data={},
        mock_eln_fields={"solvent": "DMF", "catalyst_smiles": "[Pd]"},
    )
    assert out["solvent"] == "DMF"
    assert out["catalyst_smiles"] == "[Pd]"
    assert out["_status"]["solvent"]["source"] == "mock_eln_fields_jsonb"


def test_tier1_tabular_takes_precedence_over_mock_eln():
    """tabular_data wins when both populated — it's the canonical column."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(
        tabular_data={"solvent": "EtOAc"},
        mock_eln_fields={"solvent": "DMF"},
    )
    assert out["solvent"] == "EtOAc"
    assert out["_status"]["solvent"]["source"] == "tabular_data"


def test_tier1_temperature_alias_keys():
    """Both 'temp_c' and 'temperature_c' map to temperature_c."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out_a = extract_tier1(tabular_data={"temp_c": 100}, mock_eln_fields={})
    out_b = extract_tier1(tabular_data={"temperature_c": 100}, mock_eln_fields={})
    assert out_a["temperature_c"] == 100.0
    assert out_b["temperature_c"] == 100.0


def test_tier1_invalid_temperature_dropped():
    """Non-numeric temperature is dropped; status records 'absent'."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(
        tabular_data={"temp_c": "hot"},
        mock_eln_fields={},
    )
    assert out.get("temperature_c") is None
    assert out["_status"]["temperature_c"]["status"] == "absent"


def test_tier1_atmosphere_normalized():
    """Free-form atmosphere strings → canonical 'air'/'N2'/'Ar'/'O2'."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    cases = [("argon", "Ar"), ("nitrogen", "N2"), ("AIR", "air"), ("oxygen", "O2"), ("ar", "Ar")]
    for raw, expected in cases:
        out = extract_tier1(tabular_data={"atmosphere": raw}, mock_eln_fields={})
        assert out["atmosphere"] == expected, f"{raw!r} → {out.get('atmosphere')!r}, expected {expected!r}"


def test_tier1_handles_corrupted_jsonb_gracefully():
    """If passed None or non-dict JSONB, extractor returns empty result."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(tabular_data=None, mock_eln_fields=None)
    assert out["solvent"] is None
    assert out["_status"] == {}
```

- [ ] **Step 2: Run tests, expect failure**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_extractors_tier1.py -v
```
Expected: ImportError (extractors module doesn't exist).

- [ ] **Step 3: Implement Tier 1**

```python
# services/projectors/conditions_normalizer/extractors.py
"""Three-tier conditions extractor.

Tier 1: direct JSONB copy from experiments.tabular_data + mock_eln.fields_jsonb
Tier 2: bounded regex over experiments.procedure_text
Tier 3: LiteLLM-Haiku fallback for residual freetext

All tiers are pure functions — no DB, no network. The projector orchestrates
them and persists the union.

Output shape:
    {
        "solvent": str | None,
        "solvent_smiles": str | None,
        "catalyst_smiles": str | None,
        "ligand_smiles": str | None,
        "base": str | None,
        "temperature_c": float | None,
        "time_min": float | None,
        "pressure_atm": float | None,
        "atmosphere": str | None,           # 'air' | 'N2' | 'Ar' | 'O2'
        "stoichiometry_json": dict | None,
        "_status": {field: {"status": "extracted"|"absent"|"ambiguous", "source": ...}}
    }
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# Allowed string values for atmosphere column
_ATMOSPHERE_CANONICAL = {
    "air":      "air",
    "n2":       "N2",
    "nitrogen": "N2",
    "ar":       "Ar",
    "argon":    "Ar",
    "o2":       "O2",
    "oxygen":   "O2",
}

_FIELDS = (
    "solvent", "solvent_smiles", "catalyst_smiles", "ligand_smiles",
    "base", "temperature_c", "time_min", "pressure_atm", "atmosphere",
    "stoichiometry_json",
)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _canonical_atmosphere(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    return _ATMOSPHERE_CANONICAL.get(raw.strip().lower())


def _coerce_float(raw: Any) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, bool):
        # bool is a subclass of int in Python — explicitly reject.
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _empty_result() -> dict[str, Any]:
    return {f: None for f in _FIELDS} | {"_status": {}}


def _read_field(
    src: dict[str, Any],
    keys: tuple[str, ...],
) -> Any:
    """Return the first non-None value for any key in `keys`, else None."""
    for k in keys:
        if k in src and src[k] is not None:
            return src[k]
    return None


def extract_tier1(
    tabular_data: dict[str, Any] | None,
    mock_eln_fields: dict[str, Any] | None,
) -> dict[str, Any]:
    """Direct JSONB copy from tabular_data + mock_eln fields_jsonb.

    tabular_data wins when both sources have a value (it's the canonical column;
    mock_eln_fields_jsonb is the dev-mode mirror). When neither has a value,
    the field is left null and recorded as `absent` in `_status`.
    """
    result = _empty_result()
    if not isinstance(tabular_data, dict):
        tabular_data = {}
    if not isinstance(mock_eln_fields, dict):
        mock_eln_fields = {}

    sources = [
        ("tabular_data", tabular_data),
        ("mock_eln_fields_jsonb", mock_eln_fields),
    ]

    # Field → (extractor, alias keys)
    string_keys = {
        "solvent":         ("solvent",),
        "solvent_smiles":  ("solvent_smiles",),
        "catalyst_smiles": ("catalyst_smiles",),
        "ligand_smiles":   ("ligand_smiles",),
        "base":            ("base",),
    }
    float_keys = {
        "temperature_c": ("temperature_c", "temp_c", "temp"),
        "time_min":      ("time_min", "time_minutes"),
        "pressure_atm":  ("pressure_atm",),
    }

    def _record(field: str, source: str) -> None:
        result["_status"][field] = {
            "status": "extracted",
            "source": source,
            "extracted_at": _now_iso(),
        }

    def _record_absent(field: str) -> None:
        result["_status"][field] = {"status": "absent"}

    # String fields
    for field, keys in string_keys.items():
        for source_name, src in sources:
            val = _read_field(src, keys)
            if isinstance(val, str) and val.strip():
                result[field] = val
                _record(field, source_name)
                break
        else:
            _record_absent(field)

    # Float-typed fields
    for field, keys in float_keys.items():
        for source_name, src in sources:
            raw = _read_field(src, keys)
            coerced = _coerce_float(raw)
            if coerced is not None:
                result[field] = coerced
                _record(field, source_name)
                break
        else:
            _record_absent(field)

    # Atmosphere — special-cased canonicalization
    for source_name, src in sources:
        raw = _read_field(src, ("atmosphere",))
        canon = _canonical_atmosphere(raw)
        if canon is not None:
            result["atmosphere"] = canon
            _record("atmosphere", source_name)
            break
    else:
        _record_absent("atmosphere")

    # Stoichiometry — copy as-is if it's a dict
    for source_name, src in sources:
        raw = _read_field(src, ("stoichiometry_json", "stoichiometry", "equivalents"))
        if isinstance(raw, dict):
            result["stoichiometry_json"] = raw
            _record("stoichiometry_json", source_name)
            break
    else:
        _record_absent("stoichiometry_json")

    return result
```

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_extractors_tier1.py -v
```
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add services/projectors/conditions_normalizer/extractors.py services/projectors/conditions_normalizer/tests/test_extractors_tier1.py
git commit -m "feat(z2): conditions_normalizer Tier 1 — JSONB direct copy"
```

---

## Task 4: Tier 2 — bounded regex over `procedure_text`

**Files:**
- Modify: `services/projectors/conditions_normalizer/extractors.py`
- Create: `services/projectors/conditions_normalizer/tests/test_extractors_tier2.py`

- [ ] **Step 1: Write the failing tier-2 tests**

```python
# services/projectors/conditions_normalizer/tests/test_extractors_tier2.py
"""Tier 2 (bounded regex) extraction tests."""
from __future__ import annotations

import time

import pytest


def test_tier2_extracts_temperature():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Refluxed in DCM at 80 °C for 16 h.")
    assert out["temperature_c"] == 80.0
    assert out["_status"]["temperature_c"]["source"] == "regex"


def test_tier2_extracts_time_in_hours():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Refluxed in DCM at 80 °C for 16 h.")
    assert out["time_min"] == 960.0  # 16 * 60


def test_tier2_extracts_time_in_minutes():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Stirred at rt for 30 minutes.")
    assert out["time_min"] == 30.0


def test_tier2_extracts_atmosphere():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    cases = [
        ("Reaction performed under argon.", "Ar"),
        ("under N2 atmosphere", "N2"),
        ("in air", "air"),
    ]
    for text, expected in cases:
        out = extract_tier2(text)
        assert out["atmosphere"] == expected, f"{text!r} → {out.get('atmosphere')!r}"


def test_tier2_extracts_solvent_from_known_list():
    """Solvent matched against the in-memory list of known names."""
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Compound dissolved in acetonitrile and stirred.")
    assert out["solvent"] == "Acetonitrile"
    assert out["_status"]["solvent"]["source"] == "regex"


def test_tier2_returns_absent_for_missing_fields():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Something happened.")
    assert out["temperature_c"] is None
    assert out["_status"]["temperature_c"]["status"] == "absent"


def test_tier2_handles_empty_input():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("")
    assert out["solvent"] is None
    assert out["_status"]["solvent"]["status"] == "absent"


def test_tier2_handles_none_input():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2(None)
    assert out["solvent"] is None


def test_tier2_no_catastrophic_backtracking():
    """100k-char procedure_text completes within 100 ms."""
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    huge = "x" * 100_000
    start = time.perf_counter()
    out = extract_tier2(huge)
    elapsed = time.perf_counter() - start
    assert elapsed < 0.1, f"Tier 2 took {elapsed:.3f}s on 100k input"
    assert out["solvent"] is None  # no matches in junk


def test_tier2_truncates_oversize_input():
    """Inputs over MAX_PROCEDURE_TEXT_LEN (100k) are dropped, not scanned."""
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    # Put solvent name AFTER the cutoff so we can see it's not scanned.
    text = ("y" * 100_001) + " in ethanol"
    out = extract_tier2(text)
    assert out["solvent"] is None  # cutoff prevented scan
```

- [ ] **Step 2: Run tests, expect failure**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_extractors_tier2.py -v
```
Expected: ImportError (extract_tier2 doesn't exist).

- [ ] **Step 3: Implement Tier 2 (append to extractors.py)**

Append to `services/projectors/conditions_normalizer/extractors.py`:

```python
import re

# Cap to defend against catastrophic input. Bounded regex by construction;
# this is defense-in-depth.
MAX_PROCEDURE_TEXT_LEN = 100_000

# Common solvent names. Keep this list small + canonical; longer matches go
# through the green-chemistry guide at runtime when available.
_KNOWN_SOLVENTS: dict[str, str] = {
    # lowercase pattern → canonical name
    "ethanol":           "Ethanol",
    "etoh":              "Ethanol",
    "isopropanol":       "Isopropanol",
    "iproh":             "Isopropanol",
    "methanol":          "Methanol",
    "meoh":              "Methanol",
    "water":             "Water",
    "thf":               "THF",
    "2-methf":           "2-MeTHF",
    "2-methyltetrahydrofuran": "2-MeTHF",
    "ethyl acetate":     "EtOAc",
    "etoac":             "EtOAc",
    "dcm":               "DCM",
    "dichloromethane":   "DCM",
    "chloroform":        "Chloroform",
    "hexane":            "Hexane",
    "heptane":           "Heptane",
    "toluene":           "Toluene",
    "dmf":               "DMF",
    "dimethylformamide": "DMF",
    "dmac":              "DMAc",
    "dmso":              "DMSO",
    "dimethylsulfoxide": "DMSO",
    "acetonitrile":      "Acetonitrile",
    "mecn":              "Acetonitrile",
    "acetone":           "Acetone",
    "1,4-dioxane":       "1,4-Dioxane",
    "dioxane":           "1,4-Dioxane",
    "diethyl ether":     "DEE",
    "et2o":              "DEE",
    "nmp":               "NMP",
    "n-methylpyrrolidone": "NMP",
}

# All quantifiers explicit-bounded; defends against catastrophic backtracking
# per CLAUDE.md.
_RE_TEMP = re.compile(
    r"\b(?:at|to|reflux\s+at)\s+(?P<temp>-?\d{1,3}(?:\.\d{1,2})?)\s*°?\s*C\b",
    re.IGNORECASE,
)
_RE_TIME_HOURS = re.compile(
    r"\bfor\s+(?P<n>\d{1,3}(?:\.\d{1,2})?)\s*(?:h|hours?|hr)\b",
    re.IGNORECASE,
)
_RE_TIME_MINUTES = re.compile(
    r"\bfor\s+(?P<n>\d{1,3})\s*(?:min|minutes?)\b",
    re.IGNORECASE,
)
_RE_ATMOSPHERE = re.compile(
    r"\b(?:under|in)\s+(?P<atm>nitrogen|argon|air|oxygen|N2|Ar|O2)\b",
    re.IGNORECASE,
)


def _build_solvent_pattern() -> re.Pattern[str]:
    # Sort longest-first so multi-word entries match before their substrings.
    keys = sorted(_KNOWN_SOLVENTS.keys(), key=len, reverse=True)
    escaped = [re.escape(k) for k in keys]
    return re.compile(r"\b(" + "|".join(escaped) + r")\b", re.IGNORECASE)


_RE_SOLVENT = _build_solvent_pattern()


def extract_tier2(procedure_text: str | None) -> dict[str, Any]:
    """Bounded regex over procedure_text; returns same shape as Tier 1.

    Caps input at MAX_PROCEDURE_TEXT_LEN to prevent catastrophic-input attacks
    (defense-in-depth — every quantifier is already bounded).
    """
    result = _empty_result()
    if not isinstance(procedure_text, str):
        for f in _FIELDS:
            result["_status"][f] = {"status": "absent"}
        return result
    if len(procedure_text) > MAX_PROCEDURE_TEXT_LEN:
        # Don't scan; record absent for everything.
        for f in _FIELDS:
            result["_status"][f] = {"status": "absent"}
        return result

    def _record(field: str) -> None:
        result["_status"][field] = {
            "status": "extracted",
            "source": "regex",
            "extracted_at": _now_iso(),
        }

    def _record_absent(field: str) -> None:
        result["_status"][field] = {"status": "absent"}

    # Temperature
    m = _RE_TEMP.search(procedure_text)
    if m:
        result["temperature_c"] = float(m.group("temp"))
        _record("temperature_c")
    else:
        _record_absent("temperature_c")

    # Time — hours dominate over minutes if both present (chemists usually
    # mean the longer interval as the reaction window).
    m_h = _RE_TIME_HOURS.search(procedure_text)
    m_m = _RE_TIME_MINUTES.search(procedure_text)
    if m_h:
        result["time_min"] = float(m_h.group("n")) * 60.0
        _record("time_min")
    elif m_m:
        result["time_min"] = float(m_m.group("n"))
        _record("time_min")
    else:
        _record_absent("time_min")

    # Atmosphere
    m = _RE_ATMOSPHERE.search(procedure_text)
    if m:
        canon = _canonical_atmosphere(m.group("atm"))
        if canon:
            result["atmosphere"] = canon
            _record("atmosphere")
        else:
            _record_absent("atmosphere")
    else:
        _record_absent("atmosphere")

    # Solvent
    m = _RE_SOLVENT.search(procedure_text)
    if m:
        canonical = _KNOWN_SOLVENTS[m.group(1).lower()]
        result["solvent"] = canonical
        _record("solvent")
    else:
        _record_absent("solvent")

    # Fields not extracted by Tier 2 — leave null, mark absent.
    for f in ("solvent_smiles", "catalyst_smiles", "ligand_smiles", "base",
              "pressure_atm", "stoichiometry_json"):
        _record_absent(f)

    return result
```

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_extractors_tier2.py -v
```
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add services/projectors/conditions_normalizer/extractors.py services/projectors/conditions_normalizer/tests/test_extractors_tier2.py
git commit -m "feat(z2): conditions_normalizer Tier 2 — bounded regex"
```

---

## Task 5: Tier 3 — LiteLLM-Haiku JSON-extraction fallback

**Files:**
- Create: `services/projectors/conditions_normalizer/llm_prompt.py`
- Create: `services/projectors/conditions_normalizer/tests/test_llm_extractor.py`

- [ ] **Step 1: Write the failing LLM tests**

```python
# services/projectors/conditions_normalizer/tests/test_llm_extractor.py
"""Tier 3 (LiteLLM JSON-extraction) tests. LLM is mocked."""
from __future__ import annotations

import json
from unittest import mock

import pytest


@pytest.fixture
def mock_litellm_completion():
    """Mock litellm.acompletion to return a predetermined response."""
    with mock.patch(
        "services.projectors.conditions_normalizer.llm_prompt.litellm.acompletion"
    ) as m:
        yield m


@pytest.mark.asyncio
async def test_llm_returns_parsed_fields(mock_litellm_completion):
    from services.projectors.conditions_normalizer.llm_prompt import (
        ExtractorSettings,
        extract_via_llm,
    )
    mock_litellm_completion.return_value = mock.MagicMock(
        choices=[mock.MagicMock(
            message=mock.MagicMock(
                content=json.dumps({
                    "solvent": "Toluene",
                    "catalyst_smiles": None,
                    "base": "K2CO3",
                    "temperature_c": 110,
                    "time_min": None,
                    "atmosphere": "N2",
                })
            )
        )]
    )
    settings = ExtractorSettings(
        litellm_base_url="http://x",
        litellm_api_key="k",
        agent_model_compactor="claude-haiku-4-5",
    )
    out = await extract_via_llm("Heated in toluene with K2CO3 at 110 C under N2.", settings)
    assert out["solvent"] == "Toluene"
    assert out["base"] == "K2CO3"
    assert out["temperature_c"] == 110.0
    assert out["atmosphere"] == "N2"
    assert out["_status"]["solvent"]["source"] == "llm"


@pytest.mark.asyncio
async def test_llm_validation_failure_marks_ambiguous(mock_litellm_completion):
    from services.projectors.conditions_normalizer.llm_prompt import (
        ExtractorSettings,
        extract_via_llm,
    )
    # LLM returned malformed JSON
    mock_litellm_completion.return_value = mock.MagicMock(
        choices=[mock.MagicMock(message=mock.MagicMock(content="not-json"))]
    )
    settings = ExtractorSettings(
        litellm_base_url="http://x", litellm_api_key="k", agent_model_compactor="m",
    )
    out = await extract_via_llm("anything", settings)
    # Empty result, all fields null, all marked ambiguous
    assert out["solvent"] is None
    assert out["_status"]["solvent"]["status"] == "ambiguous"
    assert out["_status"]["solvent"]["error"] == "validation_failed"


@pytest.mark.asyncio
async def test_llm_truncates_long_input(mock_litellm_completion):
    """Input over 8k chars truncated before being sent to the LLM."""
    from services.projectors.conditions_normalizer.llm_prompt import (
        ExtractorSettings,
        extract_via_llm,
    )
    mock_litellm_completion.return_value = mock.MagicMock(
        choices=[mock.MagicMock(message=mock.MagicMock(content="{}"))]
    )
    settings = ExtractorSettings(
        litellm_base_url="http://x", litellm_api_key="k", agent_model_compactor="m",
    )
    huge = "z" * 20_000
    await extract_via_llm(huge, settings)
    sent_text = mock_litellm_completion.call_args.kwargs["messages"][1]["content"]
    assert len(sent_text) <= 8_500  # 8000 chars + small overhead


@pytest.mark.asyncio
async def test_llm_skips_empty_input(mock_litellm_completion):
    """Empty / None / very short input bypasses the LLM call entirely."""
    from services.projectors.conditions_normalizer.llm_prompt import (
        ExtractorSettings,
        extract_via_llm,
    )
    settings = ExtractorSettings(
        litellm_base_url="http://x", litellm_api_key="k", agent_model_compactor="m",
    )
    out = await extract_via_llm("", settings)
    assert out["solvent"] is None
    mock_litellm_completion.assert_not_called()

    out = await extract_via_llm("hi", settings)
    assert out["solvent"] is None
    mock_litellm_completion.assert_not_called()
```

- [ ] **Step 2: Run tests, expect failure**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_llm_extractor.py -v
```
Expected: ImportError.

- [ ] **Step 3: Implement Tier 3**

```python
# services/projectors/conditions_normalizer/llm_prompt.py
"""LLM-based conditions extractor (Tier 3 fallback).

Calls LiteLLM (Haiku tier) with a strict JSON-extraction prompt. Validates
the response with Pydantic before returning. Validation failures or LLM
errors return an empty result with all fields marked 'ambiguous' so the
projector can record provenance and the calling code can decide whether
to retry.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import litellm
from pydantic import BaseModel, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("projector.conditions_normalizer.llm")

_MIN_TEXT_LEN = 50
_MAX_TEXT_LEN = 8_000

_SYSTEM_PROMPT = """You extract reaction conditions from procedure freetext.
Return a JSON object with these fields (use null when not stated):
  solvent (str), catalyst_smiles (str), ligand_smiles (str), base (str),
  temperature_c (number), time_min (number), atmosphere (one of "air","N2","Ar","O2").
Do NOT invent values. Do NOT include any prose outside the JSON object.
"""


class ExtractorSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    litellm_base_url: str
    litellm_api_key: str
    agent_model_compactor: str = "claude-haiku-4-5"


class _LLMOutput(BaseModel):
    solvent: str | None = Field(default=None, max_length=200)
    catalyst_smiles: str | None = Field(default=None, max_length=10_000)
    ligand_smiles: str | None = Field(default=None, max_length=10_000)
    base: str | None = Field(default=None, max_length=200)
    temperature_c: float | None = Field(default=None, ge=-100.0, le=500.0)
    time_min: float | None = Field(default=None, ge=0.0, le=10_000.0)
    atmosphere: str | None = None  # validated against canonical set below


_FIELDS_LLM = (
    "solvent", "catalyst_smiles", "ligand_smiles", "base",
    "temperature_c", "time_min", "atmosphere",
)
_ATM_VALID = {"air", "N2", "Ar", "O2"}


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _empty_with_status(status: str, **extra: Any) -> dict[str, Any]:
    """Return all-null result with a uniform status label per field."""
    out: dict[str, Any] = {f: None for f in _FIELDS_LLM}
    out["solvent_smiles"] = None
    out["pressure_atm"] = None
    out["stoichiometry_json"] = None
    out["_status"] = {
        f: {"status": status, **extra} for f in _FIELDS_LLM
    }
    return out


async def extract_via_llm(
    procedure_text: str | None,
    settings: ExtractorSettings,
) -> dict[str, Any]:
    """Run the LLM-tier extractor.

    Skips the LLM call entirely for missing / very-short input — bypass
    is observable to the caller via _status[*].status == 'absent'.
    """
    if not isinstance(procedure_text, str) or len(procedure_text) < _MIN_TEXT_LEN:
        return _empty_with_status("absent")

    payload = procedure_text[:_MAX_TEXT_LEN]

    try:
        resp = await litellm.acompletion(
            model=settings.agent_model_compactor,
            api_base=settings.litellm_base_url,
            api_key=settings.litellm_api_key,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": payload},
            ],
            response_format={"type": "json_object"},
            max_tokens=400,
            temperature=0.0,
        )
        raw = resp.choices[0].message.content
    except Exception as exc:  # noqa: BLE001  — broad on purpose for transient failures
        log.warning("LLM call failed: %s", exc)
        return _empty_with_status("ambiguous", source="llm", error="llm_call_failed")

    try:
        parsed = json.loads(raw)
        validated = _LLMOutput.model_validate(parsed)
    except (json.JSONDecodeError, ValidationError) as exc:
        log.warning("LLM output failed validation: %s", exc)
        return _empty_with_status("ambiguous", source="llm", error="validation_failed")

    # Atmosphere extra normalization — Pydantic doesn't enforce the enum.
    atm = validated.atmosphere
    if atm is not None and atm not in _ATM_VALID:
        atm = None

    out: dict[str, Any] = {
        "solvent":         validated.solvent,
        "solvent_smiles":  None,
        "catalyst_smiles": validated.catalyst_smiles,
        "ligand_smiles":   validated.ligand_smiles,
        "base":            validated.base,
        "temperature_c":   validated.temperature_c,
        "time_min":        validated.time_min,
        "pressure_atm":    None,
        "atmosphere":      atm,
        "stoichiometry_json": None,
    }
    out["_status"] = {}
    now = _now_iso()
    for f in _FIELDS_LLM:
        if out[f] is not None:
            out["_status"][f] = {
                "status": "extracted",
                "source": "llm",
                "model": settings.agent_model_compactor,
                "extracted_at": now,
            }
        else:
            out["_status"][f] = {"status": "absent", "source": "llm"}
    return out
```

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_llm_extractor.py -v
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add services/projectors/conditions_normalizer/llm_prompt.py services/projectors/conditions_normalizer/tests/test_llm_extractor.py
git commit -m "feat(z2): conditions_normalizer Tier 3 — LiteLLM JSON-extraction"
```

---

## Task 6: Compose three tiers into the unified extractor

**Files:**
- Modify: `services/projectors/conditions_normalizer/extractors.py`
- Create: `services/projectors/conditions_normalizer/tests/test_compose.py`

- [ ] **Step 1: Write the failing compose tests**

```python
# services/projectors/conditions_normalizer/tests/test_compose.py
"""Tests for the unified 3-tier composer."""
from __future__ import annotations

import pytest


def test_compose_tier1_wins_when_complete():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {"solvent": "EtOH", "temperature_c": 80.0,
          "_status": {"solvent": {"status": "extracted", "source": "tabular_data"},
                      "temperature_c": {"status": "extracted", "source": "tabular_data"}}}
    t2 = {"solvent": "DCM", "temperature_c": 25.0,
          "_status": {"solvent": {"status": "extracted", "source": "regex"},
                      "temperature_c": {"status": "extracted", "source": "regex"}}}
    t3 = None
    out = compose_extractions(t1, t2, t3)
    assert out["solvent"] == "EtOH"  # tier1 wins
    assert out["temperature_c"] == 80.0
    assert out["_status"]["solvent"]["source"] == "tabular_data"
    assert out["conditions_extracted_from"] == "tabular_data"


def test_compose_tier2_fills_tier1_gap():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {"solvent": None, "temperature_c": 80.0,
          "_status": {"solvent": {"status": "absent"},
                      "temperature_c": {"status": "extracted", "source": "tabular_data"}}}
    t2 = {"solvent": "DCM", "temperature_c": None,
          "_status": {"solvent": {"status": "extracted", "source": "regex"},
                      "temperature_c": {"status": "absent"}}}
    out = compose_extractions(t1, t2, None)
    assert out["solvent"] == "DCM"
    assert out["temperature_c"] == 80.0
    assert out["_status"]["solvent"]["source"] == "regex"
    # When mixed, the "primary" extracted_from is the highest-priority source
    # that contributed any value.
    assert out["conditions_extracted_from"] == "tabular_data"


def test_compose_tier3_fills_residual():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {"solvent": None, "temperature_c": None,
          "_status": {"solvent": {"status": "absent"},
                      "temperature_c": {"status": "absent"}}}
    t2 = {"solvent": None, "temperature_c": None,
          "_status": {"solvent": {"status": "absent"},
                      "temperature_c": {"status": "absent"}}}
    t3 = {"solvent": "Toluene", "temperature_c": 110.0,
          "_status": {"solvent": {"status": "extracted", "source": "llm"},
                      "temperature_c": {"status": "extracted", "source": "llm"}}}
    out = compose_extractions(t1, t2, t3)
    assert out["solvent"] == "Toluene"
    assert out["temperature_c"] == 110.0
    assert out["conditions_extracted_from"] == "llm"


def test_compose_all_absent_returns_none_source():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {"solvent": None, "_status": {"solvent": {"status": "absent"}}}
    t2 = {"solvent": None, "_status": {"solvent": {"status": "absent"}}}
    t3 = None
    out = compose_extractions(t1, t2, t3)
    assert out["solvent"] is None
    assert out["conditions_extracted_from"] == "none"


def test_compose_handles_missing_t3():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {"solvent": "EtOH",
          "_status": {"solvent": {"status": "extracted", "source": "tabular_data"}}}
    t2 = {"solvent": None, "_status": {"solvent": {"status": "absent"}}}
    out = compose_extractions(t1, t2, None)  # tier3 disabled by config
    assert out["solvent"] == "EtOH"
```

- [ ] **Step 2: Run tests, expect failure**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_compose.py -v
```
Expected: ImportError (compose_extractions doesn't exist).

- [ ] **Step 3: Implement compose_extractions in extractors.py**

Append to `services/projectors/conditions_normalizer/extractors.py`:

```python
_FIELDS_COMPOSE = (
    "solvent", "solvent_smiles", "catalyst_smiles", "ligand_smiles",
    "base", "temperature_c", "time_min", "pressure_atm", "atmosphere",
    "stoichiometry_json",
)
_SOURCE_PRIORITY = {
    "tabular_data": 0,
    "mock_eln_fields_jsonb": 1,
    "regex": 2,
    "llm": 3,
}


def compose_extractions(
    tier1: dict[str, Any] | None,
    tier2: dict[str, Any] | None,
    tier3: dict[str, Any] | None,
) -> dict[str, Any]:
    """Merge three tiers, earliest-wins. Returns a single dict ready to write
    to `reactions`.

    Output:
        {field: value | None, ...,
         "extraction_status": {field: {"status": ..., "source": ..., ...}},
         "conditions_extracted_from": "tabular_data"|"mock_eln_fields_jsonb"|"regex"|"llm"|"none"}
    """
    out: dict[str, Any] = {f: None for f in _FIELDS_COMPOSE}
    out["extraction_status"] = {}

    tiers = [t for t in (tier1, tier2, tier3) if isinstance(t, dict)]

    for f in _FIELDS_COMPOSE:
        for t in tiers:
            value = t.get(f)
            if value is not None:
                out[f] = value
                status = t.get("_status", {}).get(f, {"status": "extracted"})
                out["extraction_status"][f] = status
                break
        else:
            # No tier had a value
            statuses = [t.get("_status", {}).get(f, {"status": "absent"}) for t in tiers]
            # Prefer 'ambiguous' over 'absent' if any tier reported it
            ambiguous = [s for s in statuses if s.get("status") == "ambiguous"]
            out["extraction_status"][f] = ambiguous[0] if ambiguous else {"status": "absent"}

    # conditions_extracted_from = highest-priority source that contributed any value
    sources_used = [
        out["extraction_status"][f].get("source")
        for f in _FIELDS_COMPOSE
        if out["extraction_status"][f].get("status") == "extracted"
    ]
    sources_used = [s for s in sources_used if s in _SOURCE_PRIORITY]
    if sources_used:
        out["conditions_extracted_from"] = min(sources_used, key=_SOURCE_PRIORITY.get)
    else:
        out["conditions_extracted_from"] = "none"

    return out
```

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_compose.py -v
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add services/projectors/conditions_normalizer/extractors.py services/projectors/conditions_normalizer/tests/test_compose.py
git commit -m "feat(z2): conditions_normalizer compose 3 tiers into unified result"
```

---

## Task 7: Projector main — handle event + write UPDATE

**Files:**
- Modify: `services/projectors/conditions_normalizer/main.py`
- Create: `services/projectors/conditions_normalizer/tests/test_handle.py`

- [ ] **Step 1: Write the failing handler tests**

```python
# services/projectors/conditions_normalizer/tests/test_handle.py
"""Handler-level tests for the conditions_normalizer projector.

Mocks DB connection + LLM. The handler is tested as a pure async function
called with synthetic event payloads.
"""
from __future__ import annotations

import json
from unittest import mock

import pytest


def _make_settings():
    from services.projectors.conditions_normalizer.main import Settings
    return Settings(
        _env_file=None,
        postgres_host="localhost",
        postgres_db="x",
        postgres_user="x",
        postgres_password="x",
        mcp_rdkit_url="http://test",
        litellm_base_url="http://test",
        litellm_api_key="k",
        agent_model_compactor="m",
        conditions_normalizer_llm_fallback=False,  # disable LLM in default tests
    )


@pytest.mark.asyncio
async def test_handle_writes_update_for_each_reaction():
    """Two reactions in the experiment → two UPDATE statements."""
    from services.projectors.conditions_normalizer.main import ConditionsNormalizer

    proj = ConditionsNormalizer(_make_settings())

    fetched_rows = [
        {
            "reaction_id": "rxn-a",
            "rxn_smiles": "CC>>CC",
            "procedure_text": "Stirred in DCM at 80 °C for 16 h.",
            "tabular_data": {"solvent": "DCM"},
            "mock_eln_fields": {},
        },
        {
            "reaction_id": "rxn-b",
            "rxn_smiles": "CO>>CO",
            "procedure_text": "Refluxed in EtOH for 30 minutes.",
            "tabular_data": {},
            "mock_eln_fields": {},
        },
    ]
    cursor = mock.MagicMock()
    cursor.fetchall.return_value = fetched_rows
    cursor.execute = mock.MagicMock()
    cursor.__aenter__ = mock.AsyncMock(return_value=cursor)
    cursor.__aexit__ = mock.AsyncMock(return_value=None)

    conn = mock.MagicMock()
    conn.cursor.return_value = cursor

    with mock.patch.object(proj, "_open_work_conn", return_value=conn):
        await proj.handle(
            event_id="evt-1",
            event_type="experiment_imported",
            source_table="experiments",
            source_row_id="exp-1",
            payload={"experiment_id": "exp-1"},
        )

    # Expect: 1 SELECT to load context + 2 UPDATEs for two reactions.
    update_calls = [c for c in cursor.execute.call_args_list if "UPDATE reactions" in c.args[0]]
    assert len(update_calls) == 2


@pytest.mark.asyncio
async def test_handle_skips_event_with_no_reactions():
    """An experiment with no reactions emits no UPDATE."""
    from services.projectors.conditions_normalizer.main import ConditionsNormalizer

    proj = ConditionsNormalizer(_make_settings())

    cursor = mock.MagicMock()
    cursor.fetchall.return_value = []
    cursor.execute = mock.MagicMock()
    cursor.__aenter__ = mock.AsyncMock(return_value=cursor)
    cursor.__aexit__ = mock.AsyncMock(return_value=None)
    conn = mock.MagicMock()
    conn.cursor.return_value = cursor

    with mock.patch.object(proj, "_open_work_conn", return_value=conn):
        await proj.handle(
            event_id="evt-2",
            event_type="experiment_imported",
            source_table="experiments",
            source_row_id="exp-noreact",
            payload={"experiment_id": "exp-noreact"},
        )

    update_calls = [c for c in cursor.execute.call_args_list if "UPDATE reactions" in c.args[0]]
    assert update_calls == []


@pytest.mark.asyncio
async def test_handle_unrelated_event_type_is_noop():
    """Events with mismatched event_type don't issue any DB calls."""
    from services.projectors.conditions_normalizer.main import ConditionsNormalizer

    proj = ConditionsNormalizer(_make_settings())
    work_conn_mock = mock.MagicMock()

    with mock.patch.object(proj, "_open_work_conn", return_value=work_conn_mock):
        await proj.handle(
            event_id="evt-3",
            event_type="some_other_event",
            source_table=None,
            source_row_id=None,
            payload={},
        )

    work_conn_mock.cursor.assert_not_called()
```

- [ ] **Step 2: Run tests, expect failure**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_handle.py -v
```
Expected: AttributeError — handle is still a no-op.

- [ ] **Step 3: Replace handler in main.py**

Replace the entire content of `services/projectors/conditions_normalizer/main.py` with:

```python
"""conditions_normalizer — promote reaction conditions to first-class columns."""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import psycopg
from psycopg.rows import dict_row
from pydantic_settings import SettingsConfigDict

from services.projectors.common.base import BaseProjector, ProjectorSettings
from services.projectors.conditions_normalizer.extractors import (
    compose_extractions,
    extract_tier1,
    extract_tier2,
)
from services.projectors.conditions_normalizer.llm_prompt import (
    ExtractorSettings,
    extract_via_llm,
)

log = logging.getLogger("projector.conditions_normalizer")


class Settings(ProjectorSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    mcp_rdkit_url: str = "http://localhost:8001"
    conditions_normalizer_llm_fallback: bool = True
    litellm_base_url: str = "http://localhost:4000"
    litellm_api_key: str = ""
    agent_model_compactor: str = "claude-haiku-4-5"


_LOAD_CONTEXT_SQL = """
SELECT r.id AS reaction_id,
       r.rxn_smiles,
       e.procedure_text,
       COALESCE(e.tabular_data, '{}'::jsonb) AS tabular_data,
       COALESCE(me_fields.fields_jsonb, '{}'::jsonb) AS mock_eln_fields
  FROM experiments e
  JOIN reactions r ON r.experiment_id = e.id
  LEFT JOIN LATERAL (
      SELECT fields_jsonb FROM mock_eln.entries me
       WHERE me.id::text = e.eln_entry_id
       LIMIT 1
  ) me_fields ON to_regclass('mock_eln.entries') IS NOT NULL
 WHERE e.id = %s
"""

_UPDATE_SQL = """
UPDATE reactions
   SET solvent              = COALESCE(solvent,              %(solvent)s),
       solvent_smiles       = COALESCE(solvent_smiles,       %(solvent_smiles)s),
       catalyst_smiles      = COALESCE(catalyst_smiles,      %(catalyst_smiles)s),
       ligand_smiles        = COALESCE(ligand_smiles,        %(ligand_smiles)s),
       base                 = COALESCE(base,                 %(base)s),
       temperature_c        = COALESCE(temperature_c,        %(temperature_c)s),
       time_min             = COALESCE(time_min,             %(time_min)s),
       pressure_atm         = COALESCE(pressure_atm,         %(pressure_atm)s),
       atmosphere           = COALESCE(atmosphere,           %(atmosphere)s),
       stoichiometry_json   = COALESCE(stoichiometry_json,   %(stoichiometry_json)s::jsonb),
       conditions_extracted_from = COALESCE(conditions_extracted_from, %(extracted_from)s),
       extraction_status    = extraction_status || %(status)s::jsonb
 WHERE id = %(reaction_id)s
"""


class ConditionsNormalizer(BaseProjector):
    name = "conditions_normalizer"
    interested_event_types = ("experiment_imported",)

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self._settings = settings

    @asynccontextmanager
    async def _open_work_conn(self) -> AsyncIterator[Any]:
        async with await psycopg.AsyncConnection.connect(
            self._settings.postgres_dsn,
            row_factory=dict_row,
        ) as conn:
            yield conn

    async def handle(
        self,
        event_id: Any,
        event_type: str,
        source_table: str | None,
        source_row_id: Any,
        payload: dict[str, Any],
    ) -> None:
        if event_type not in self.interested_event_types:
            return

        experiment_id = payload.get("experiment_id") or source_row_id
        if not experiment_id:
            log.warning("experiment_imported event %s lacks experiment_id", event_id)
            return

        async with self._open_work_conn() as conn:
            async with conn.cursor() as cur:
                await cur.execute(_LOAD_CONTEXT_SQL, (experiment_id,))
                rows = await cur.fetchall()

                for row in rows:
                    await self._normalize_reaction(cur, row)

                await conn.commit()

    async def _normalize_reaction(self, cur: Any, row: dict[str, Any]) -> None:
        # Tier 1
        tier1 = extract_tier1(row.get("tabular_data"), row.get("mock_eln_fields"))

        # Tier 2 — only run if any tier1 slot is empty
        any_missing_after_t1 = any(
            tier1.get(f) is None
            for f in ("solvent", "temperature_c", "time_min", "atmosphere")
        )
        tier2 = extract_tier2(row.get("procedure_text")) if any_missing_after_t1 else None

        # Tier 3 — only run if LLM enabled AND any slot still missing
        tier3 = None
        if self._settings.conditions_normalizer_llm_fallback:
            merged_so_far = compose_extractions(tier1, tier2, None)
            still_missing = any(
                merged_so_far.get(f) is None
                for f in ("solvent", "catalyst_smiles", "ligand_smiles", "base",
                          "temperature_c", "time_min", "atmosphere")
            )
            if still_missing:
                ext_settings = ExtractorSettings(
                    litellm_base_url=self._settings.litellm_base_url,
                    litellm_api_key=self._settings.litellm_api_key,
                    agent_model_compactor=self._settings.agent_model_compactor,
                )
                tier3 = await extract_via_llm(row.get("procedure_text"), ext_settings)

        merged = compose_extractions(tier1, tier2, tier3)

        params = {
            "reaction_id":         row["reaction_id"],
            "solvent":             merged.get("solvent"),
            "solvent_smiles":      merged.get("solvent_smiles"),
            "catalyst_smiles":     merged.get("catalyst_smiles"),
            "ligand_smiles":       merged.get("ligand_smiles"),
            "base":                merged.get("base"),
            "temperature_c":       merged.get("temperature_c"),
            "time_min":            merged.get("time_min"),
            "pressure_atm":        merged.get("pressure_atm"),
            "atmosphere":          merged.get("atmosphere"),
            "stoichiometry_json":  json.dumps(merged.get("stoichiometry_json"))
                                       if merged.get("stoichiometry_json") is not None else None,
            "extracted_from":      merged.get("conditions_extracted_from"),
            "status":              json.dumps(merged.get("extraction_status", {})),
        }
        await cur.execute(_UPDATE_SQL, params)
```

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/test_handle.py -v
```
Expected: 3 passed.

- [ ] **Step 5: Run full projector test suite**

```bash
.venv/bin/pytest services/projectors/conditions_normalizer/tests/ -v
```
Expected: 24 passed (2 skeleton + 7 tier1 + 10 tier2 + 4 LLM + 5 compose - some overlap).

(Recount: 2 + 7 + 10 + 4 + 5 + 3 = 31 passing tests.)

- [ ] **Step 6: Commit**

```bash
git add services/projectors/conditions_normalizer/main.py services/projectors/conditions_normalizer/tests/test_handle.py
git commit -m "feat(z2): conditions_normalizer handler — load context + write UPDATE"
```

---

## Task 8: Dockerfile + docker-compose registration

**Files:**
- Create: `services/projectors/conditions_normalizer/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add Dockerfile**

```dockerfile
# services/projectors/conditions_normalizer/Dockerfile
FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY services/projectors/conditions_normalizer/requirements.txt /app/services/projectors/conditions_normalizer/requirements.txt
RUN pip install --no-cache-dir -r /app/services/projectors/conditions_normalizer/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/projectors/__init__.py /app/services/projectors/__init__.py
COPY services/projectors/common /app/services/projectors/common
COPY services/projectors/conditions_normalizer /app/services/projectors/conditions_normalizer

ENV PYTHONPATH=/app

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "services.projectors.conditions_normalizer.main"]
```

- [ ] **Step 2: Add a `__main__` entry to main.py**

Append to `services/projectors/conditions_normalizer/main.py`:

```python
if __name__ == "__main__":
    import asyncio

    from services.mcp_tools.common.logging import configure_logging

    settings = Settings(_env_file=None)
    configure_logging(settings.projector_log_level)
    proj = ConditionsNormalizer(settings)
    asyncio.run(proj.run())
```

- [ ] **Step 3: Register in docker-compose.yml**

Find the existing `reaction-vectorizer` service block (search for `reaction-vectorizer:`). Insert immediately after its closing block:

```yaml
  # -------------------------------------------------------------
  # conditions-normalizer — extract reaction conditions from
  # procedure_text + tabular_data into first-class columns
  # -------------------------------------------------------------
  conditions-normalizer:
    build:
      context: .
      dockerfile: services/projectors/conditions_normalizer/Dockerfile
    container_name: chemclaw-conditions-normalizer
    restart: unless-stopped
    profiles: ["full"]
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_DB: chemclaw
      POSTGRES_USER: chemclaw_service
      POSTGRES_PASSWORD: ${POSTGRES_SERVICE_PASSWORD:?required}
      MCP_RDKIT_URL: http://mcp-rdkit:8001
      CONDITIONS_NORMALIZER_LLM_FALLBACK: ${CONDITIONS_NORMALIZER_LLM_FALLBACK:-false}
      LITELLM_BASE_URL: http://litellm:4000
      LITELLM_API_KEY: ${LITELLM_MASTER_KEY:?required}
      AGENT_MODEL_COMPACTOR: ${AGENT_MODEL_COMPACTOR:-claude-haiku-4-5}
      PROJECTOR_LOG_LEVEL: ${LOG_LEVEL:-INFO}
    security_opt:
      - no-new-privileges:true
```

- [ ] **Step 4: Verify compose parses**

```bash
docker compose --profile full config --services 2>&1 | grep conditions-normalizer
```
Expected: `conditions-normalizer` is listed.

- [ ] **Step 5: Commit**

```bash
git add services/projectors/conditions_normalizer/Dockerfile services/projectors/conditions_normalizer/main.py docker-compose.yml
git commit -m "feat(z2): conditions_normalizer Dockerfile + compose registration"
```

---

## Task 9: Update `statistical_analyze.ts` to read structured columns

**Files:**
- Modify: `services/agent-claw/src/tools/builtins/statistical_analyze.ts`
- Modify: `services/agent-claw/tests/unit/builtins/statistical_analyze.test.ts`

- [ ] **Step 1: Find current SQL fragment**

```bash
grep -n "tabular_data->>" services/agent-claw/src/tools/builtins/statistical_analyze.ts
```
Identify each line that reads `e.tabular_data->>'solvent'` etc. — typically inside the COMPARE_CONDITIONS_SQL and FEATURE_IMPORTANCE_SQL constants.

- [ ] **Step 2: Replace each tabular_data lookup with COALESCE form**

Edit each instance:

```typescript
// Before:
e.tabular_data->>'solvent' AS solvent
// After:
COALESCE(r.solvent, e.tabular_data->>'solvent') AS solvent

// Before:
(e.tabular_data->>'temp_c')::numeric AS temp_c
// After:
COALESCE(r.temperature_c, (e.tabular_data->>'temp_c')::numeric) AS temp_c

// Before:
(e.tabular_data->>'time_min')::numeric AS time_min
// After:
COALESCE(r.time_min, (e.tabular_data->>'time_min')::numeric) AS time_min

// Before:
e.tabular_data->>'catalyst_loading_mol_pct' AS catalyst_loading_mol_pct
// After (no structured column for this; keep JSONB-only):
e.tabular_data->>'catalyst_loading_mol_pct' AS catalyst_loading_mol_pct

// Before:
e.tabular_data->>'base' AS base
// After:
COALESCE(r.base, e.tabular_data->>'base') AS base

// Before:
e.tabular_data->>'catalyst_smiles' AS catalyst_smiles  (if present)
// After:
COALESCE(r.catalyst_smiles, e.tabular_data->>'catalyst_smiles') AS catalyst_smiles
```

The exact lines depend on what's in the file today; the *rule* is: any column that has a corresponding structured column on `reactions` (per Task 1's schema) gets the COALESCE form. Columns without a structured equivalent (e.g. `catalyst_loading_mol_pct`) stay as-is.

- [ ] **Step 3: Add a regression test for COALESCE precedence**

In `services/agent-claw/tests/unit/builtins/statistical_analyze.test.ts`, add:

```typescript
describe("COALESCE precedence — Z2", () => {
  it("uses structured r.solvent when present, ignoring JSONB", async () => {
    // The pool mock returns a row where r.solvent='EtOH' (structured) AND
    // e.tabular_data->>'solvent'='DCM' (JSONB). The SQL should resolve to EtOH.
    const pool = makePoolMockReturning([
      { reaction_id: "r1", solvent: "EtOH", temp_c: 80, time_min: 16, base: "K2CO3", yield_pct: 80 },
    ]);
    const tool = buildStatisticalAnalyzeTool(pool as never, "http://tabicl");
    const result = await tool.execute(makeCtx(), {
      reaction_ids: ["r1", "r2", "r3", "r4", "r5"],
      question: "compare_conditions",
    });
    // The SQL string should contain COALESCE for solvent
    expect(pool.lastSqlSeen).toMatch(/COALESCE\(r\.solvent,\s*e\.tabular_data->>'solvent'\)/i);
  });

  it("falls back to JSONB when r.solvent is null", async () => {
    const pool = makePoolMockReturning([
      { reaction_id: "r1", solvent: "DCM", temp_c: null, time_min: null, base: null, yield_pct: 50 },
    ]);
    const tool = buildStatisticalAnalyzeTool(pool as never, "http://tabicl");
    const result = await tool.execute(makeCtx(), {
      reaction_ids: ["r1", "r2", "r3", "r4", "r5"],
      question: "compare_conditions",
    });
    expect(result.condition_comparison?.[0].bucket_label).toContain("DCM");
  });
});
```

The existing test file likely has a `makePoolMockReturning` helper or similar. If not, add a minimal one that records `lastSqlSeen` and serves the supplied rows for any query.

- [ ] **Step 4: Run tests; expect pass**

```bash
cd services/agent-claw && npx vitest run tests/unit/builtins/statistical_analyze.test.ts -v
```
Expected: existing tests still pass + 2 new tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-conditions-schema-z2
git add services/agent-claw/src/tools/builtins/statistical_analyze.ts services/agent-claw/tests/unit/builtins/statistical_analyze.test.ts
git commit -m "feat(z2): statistical_analyze reads structured cols with JSONB fallback"
```

---

## Task 10: Add optional structured-column filter to `find_similar_reactions.ts`

**Files:**
- Modify: `services/agent-claw/src/tools/builtins/find_similar_reactions.ts`
- Modify: `services/agent-claw/tests/unit/builtins/find_similar_reactions.test.ts`

- [ ] **Step 1: Extend Zod input schema**

Edit `services/agent-claw/src/tools/builtins/find_similar_reactions.ts`. Find:

```typescript
export const FindSimilarReactionsIn = z.object({
  rxn_smiles: z.string().min(3).max(20_000),
  k: z.number().int().min(1).max(50).default(10),
  rxno_class: z.string().max(200).optional(),
  min_yield_pct: z.number().min(0).max(100).optional(),
});
```

Replace with:

```typescript
export const FindSimilarReactionsIn = z.object({
  rxn_smiles: z.string().min(3).max(20_000),
  k: z.number().int().min(1).max(50).default(10),
  rxno_class: z.string().max(200).optional(),
  min_yield_pct: z.number().min(0).max(100).optional(),
  // Phase Z2 — optional structured-column filters
  solvent: z.string().max(100).optional(),
  base: z.string().max(100).optional(),
  min_temperature_c: z.number().min(-100).max(500).optional(),
  max_temperature_c: z.number().min(-100).max(500).optional(),
});
```

- [ ] **Step 2: Add WHERE-clause fragments to the SQL**

Find the SQL block that reads:

```sql
WHERE r.drfp_vector IS NOT NULL
  AND ($rxno_class::text IS NULL OR r.rxno_class = $rxno_class)
  AND ($min_yield::numeric IS NULL OR e.yield_pct >= $min_yield)
```

Append the new filters:

```sql
  AND ($solvent::text IS NULL OR r.solvent = $solvent)
  AND ($base::text IS NULL OR r.base = $base)
  AND ($min_temp::numeric IS NULL OR r.temperature_c >= $min_temp)
  AND ($max_temp::numeric IS NULL OR r.temperature_c <= $max_temp)
```

Pass the new params through to `client.query`. The exact param-passing style in the file is positional with `$N` placeholders — add four new positions.

- [ ] **Step 3: Add tests**

In `services/agent-claw/tests/unit/builtins/find_similar_reactions.test.ts`, add:

```typescript
describe("Z2 structured-column filters", () => {
  it("forwards solvent param to SQL", async () => {
    const pool = mockPoolWithSqlCapture();
    const tool = buildFindSimilarReactionsTool(pool as never, "http://drfp");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ vector: Array(2048).fill(0), on_bit_count: 0 }),
    }));
    await tool.execute(makeCtx(), {
      rxn_smiles: "CC>>CC",
      k: 5,
      solvent: "EtOH",
    });
    expect(pool.lastSqlSeen).toMatch(/r\.solvent = \$\d+/);
    expect(pool.lastParamsSeen).toContain("EtOH");
  });

  it("filters on temperature range", async () => {
    const pool = mockPoolWithSqlCapture();
    const tool = buildFindSimilarReactionsTool(pool as never, "http://drfp");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ vector: Array(2048).fill(0), on_bit_count: 0 }),
    }));
    await tool.execute(makeCtx(), {
      rxn_smiles: "CC>>CC",
      min_temperature_c: 50,
      max_temperature_c: 120,
    });
    expect(pool.lastSqlSeen).toMatch(/r\.temperature_c >= \$\d+/);
    expect(pool.lastSqlSeen).toMatch(/r\.temperature_c <= \$\d+/);
    expect(pool.lastParamsSeen).toContain(50);
    expect(pool.lastParamsSeen).toContain(120);
  });

  it("does not break existing callers (no new params)", async () => {
    const pool = mockPoolWithSqlCapture();
    const tool = buildFindSimilarReactionsTool(pool as never, "http://drfp");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ vector: Array(2048).fill(0), on_bit_count: 0 }),
    }));
    await tool.execute(makeCtx(), { rxn_smiles: "CC>>CC", k: 5 });
    // Solvent filter is null → SQL still includes the clause but bound to null
    expect(pool.lastParamsSeen).toContain(null);
  });
});
```

The `mockPoolWithSqlCapture` helper either already exists in this file or is a small addition that records `lastSqlSeen` + `lastParamsSeen` on every `client.query` call.

- [ ] **Step 4: Run tests**

```bash
cd services/agent-claw && npx vitest run tests/unit/builtins/find_similar_reactions.test.ts -v
```
Expected: existing tests still pass + 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-conditions-schema-z2
git add services/agent-claw/src/tools/builtins/find_similar_reactions.ts services/agent-claw/tests/unit/builtins/find_similar_reactions.test.ts
git commit -m "feat(z2): find_similar_reactions optional structured-col filters"
```

---

## Task 11: Final verification — lint, typecheck, full test suites

**Files:** none (verification only)

- [ ] **Step 1: Lint Python changes**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-conditions-schema-z2
.venv/bin/ruff check services/projectors/conditions_normalizer/
```
Expected: All checks passed!

- [ ] **Step 2: Lint TS changes**

```bash
cd services/agent-claw && npx eslint \
    src/tools/builtins/statistical_analyze.ts \
    src/tools/builtins/find_similar_reactions.ts \
    tests/unit/builtins/statistical_analyze.test.ts \
    tests/unit/builtins/find_similar_reactions.test.ts
```
Expected: clean.

- [ ] **Step 3: Typecheck**

```bash
cd services/agent-claw && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Full pytest for the new projector**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-conditions-schema-z2
.venv/bin/pytest services/projectors/conditions_normalizer/tests/ -v
```
Expected: 31 passed (skeleton 2 + tier1 7 + tier2 10 + LLM 4 + compose 5 + handler 3).

- [ ] **Step 5: Full vitest**

```bash
cd services/agent-claw && npm test 2>&1 | tail -10
```
Expected: ≥ 804 passed (Z1 baseline) + ~5 new tests across statistical_analyze + find_similar_reactions.

- [ ] **Step 6: Schema idempotency check (if Postgres up)**

```bash
make db.init && make db.init
```
Expected: both runs complete; second is a no-op.

- [ ] **Step 7: If clean, this task is done. No commit needed unless you found and fixed something during verification.**

```bash
git status --short
```
Expected: clean (or any verification-driven fixups committed in a single `chore(z2): final verification touch-ups` commit).

---

## Self-Review

**Spec coverage:** every section of the spec maps to at least one task —
- Schema additions → Task 1.
- conditions_normalizer projector + 3-tier extraction → Tasks 2, 3, 4, 5, 6, 7.
- Dockerfile + compose → Task 8.
- Consumer updates (statistical_analyze + find_similar_reactions) → Tasks 9, 10.
- Error-handling table behaviors → covered across Tasks 3, 4, 5, 7 tests.
- Testing strategy 3-layer (pure-function unit + projector integration + consumer regression) → covered across Tasks 3-7 (units), 7 (handler integration via mocked DB), 9-10 (consumer regressions).
- Out-of-scope items (KG projection, full backfill script, kg_experiments update) — confirmed absent from tasks.

**Placeholder scan:** every step has runnable code or commands; no TBD/TODO.

**Type consistency:** the column names, JSON shape (`{status, source, extracted_at}`), enum values for `conditions_extracted_from` (`tabular_data | mock_eln_fields_jsonb | regex | llm | none`), and atmosphere canonicalization (`air | N2 | Ar | O2`) are consistent across schema (Task 1), Tier 1 (Task 3), Tier 2 (Task 4), Tier 3 (Task 5), composer (Task 6), handler SQL (Task 7), and consumer SQL (Task 9). The test for `extraction_status[field]` shape in Task 3 matches what the composer writes in Task 6 and what the handler persists in Task 7.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-01-z2-conditions-schema.md`.

Per the user's standing instruction ("when done with writing implementation plan, directly start implementation"), proceed inline via `superpowers:executing-plans`.
