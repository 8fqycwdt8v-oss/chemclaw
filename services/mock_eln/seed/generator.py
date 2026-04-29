"""Mock ELN seed generator.

Reads `world.yaml` next to this file and emits:
  - Postgres COPY-format gzipped fixture files in
    test-fixtures/mock_eln/world-default/<table>.copy.gz
  - A single idempotent seed loader at db/seed/20_mock_eln_data.sql
    that \\copies the gzipped fixtures into mock_eln.* tables.

Determinism: re-running with the same WORLD_SEED env var (default 42)
produces byte-identical output. UUIDs are derived from a deterministic
seed via uuid.uuid5(NAMESPACE, key) so they are stable across runs.

Usage:
    python -m services.mock_eln.seed.generator
    WORLD_SEED=42 python -m services.mock_eln.seed.generator

The seed loader is gated by `current_setting('app.mock_eln_enabled', true)`.

Module structure (after PR-7 split):
    generator.py             — paths, constants, generic helpers, GenState,
                               generate() orchestrator, write_seed_sql, run, __main__
    chemistry_families.py    — RDKit reaction expansion + per-project chemistry
    ofat_campaigns.py        — OFAT campaign reaction setup + entry emission
    entry_shapes.py          — shape-rendering helper + Discovery entries +
                               sample_yield / pick_conditions closures
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import os
import random
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from .chemistry_families import emit_per_project_chemistry
from .entry_shapes import emit_derived_data, emit_discovery_entries
from .ofat_campaigns import emit_ofat_entries, setup_ofat_reactions

# --------------------------------------------------------------------------
# Constants & paths
# --------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[3]
SEED_DIR = Path(__file__).resolve().parent
WORLD_YAML = SEED_DIR / "world.yaml"
FIXTURES_DIR = REPO_ROOT / "test-fixtures" / "mock_eln" / "world-default"
SEED_SQL_PATH = REPO_ROOT / "db" / "seed" / "20_mock_eln_data.sql"

# Stable UUID namespace so re-runs produce identical primary keys.
UUID_NAMESPACE = uuid.UUID("4e8b1c2d-7a3f-4b5e-9c8a-1d2e3f4a5b6c")

# Fraction of entries-with-freetext that get an adversarial probe in their
# narrative (prompt-injection bait, fabricated fact_id, etc.). Keeps the
# agent's redact-secrets + anti-fabrication safety hooks under continuous
# regression coverage. ~0.5% of ~1860 freetext-bearing entries → ~9
# adversarial entries in the default world.
ADVERSARIAL_RATE = 0.005

# Tables, in load order (FK-respecting).
TABLE_ORDER = [
    "projects",
    "notebooks",
    "methods",
    "compounds",
    "reactions",
    "entries",
    "entry_attachments",
    "samples",
    "results",
    "audit_trail",
]

# Column order for each COPY file. The seed loader uses identical orderings.
COLUMNS: dict[str, list[str]] = {
    "projects": [
        "id", "code", "name", "therapeutic_area", "started_at", "ended_at",
        "pi_email", "metadata", "created_at", "updated_at",
    ],
    "notebooks": [
        "id", "project_id", "name", "kind", "metadata", "created_at", "updated_at",
    ],
    "methods": [
        "id", "code", "name", "instrument_kind", "description", "parameters",
        "created_at",
    ],
    "compounds": [
        "id", "smiles_canonical", "inchikey", "mw", "external_id",
        "project_id", "metadata", "created_at",
    ],
    "reactions": [
        "id", "canonical_smiles_rxn", "family", "step_number", "project_id",
        "metadata", "created_at",
    ],
    "entries": [
        "id", "notebook_id", "project_id", "reaction_id", "schema_kind",
        "title", "author_email", "signed_by", "status", "entry_shape",
        "data_quality_tier", "fields_jsonb", "freetext", "freetext_length_chars",
        "created_at", "modified_at", "signed_at",
    ],
    "entry_attachments": [
        "id", "entry_id", "filename", "mime_type", "size_bytes", "description",
        "uri", "created_at",
    ],
    "samples": [
        "id", "entry_id", "sample_code", "compound_id", "amount_mg", "purity_pct",
        "notes", "created_at",
    ],
    "results": [
        "id", "sample_id", "method_id", "metric", "value_num", "value_text",
        "unit", "measured_at", "metadata", "created_at",
    ],
    "audit_trail": [
        "id", "entry_id", "actor_email", "action", "field_path", "old_value",
        "new_value", "reason", "occurred_at",
    ],
}

# Allow-list pattern for the relative fixtures path interpolated into the
# seed loader's ``\\copy ... FROM PROGRAM 'gunzip -c {rel}'`` line. Keeps
# the loader robust even if a future caller passes a non-canonical path.
_REL_PATH_RE = re.compile(r"^[A-Za-z0-9_./\-]+$")


# --------------------------------------------------------------------------
# Generic helpers
# --------------------------------------------------------------------------
def stable_uuid(*parts: Any) -> str:
    key = "|".join(str(p) for p in parts)
    return str(uuid.uuid5(UUID_NAMESPACE, key))


def iso(dt: datetime) -> str:
    """Stable ISO 8601 string. Always UTC."""
    return dt.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S+00")


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s)


def jstr(obj: Any) -> str:
    """JSON serializer with stable key order so output is byte-identical."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def weighted_pick(rng: random.Random, weights: dict[str, float]) -> str:
    keys = list(weights.keys())
    w = list(weights.values())
    return rng.choices(keys, weights=w, k=1)[0]


def dist_assign(
    rng: random.Random, n: int, weights: dict[str, float]
) -> list[str]:
    """Assign N items across categories per `weights`, exact integer counts."""
    keys = list(weights.keys())
    raw = [(k, weights[k] * n) for k in keys]
    floors = [(k, int(v)) for k, v in raw]
    remainder = n - sum(c for _, c in floors)
    fracs = sorted(
        ((k, raw[i][1] - floors[i][1]) for i, k in enumerate(keys)),
        key=lambda x: -x[1],
    )
    counts = dict(floors)
    for i in range(remainder):
        counts[fracs[i % len(fracs)][0]] += 1
    out: list[str] = []
    for k, c in counts.items():
        out.extend([k] * c)
    rng.shuffle(out)
    return out


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------
@dataclass
class GenState:
    rows: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def add(self, table: str, row: dict[str, Any]) -> None:
        self.rows.setdefault(table, []).append(row)

    def count(self, table: str) -> int:
        return len(self.rows.get(table, []))


# --------------------------------------------------------------------------
# CSV writer
# --------------------------------------------------------------------------
def _coerce_csv(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v != v:  # NaN guard
            return ""
        return repr(v)
    return str(v)


def write_csv_gz(path: Path, columns: list[str], rows: list[dict[str, Any]]) -> None:
    """Write rows as gzipped CSV. Empty string = NULL on COPY ... CSV WITH NULL ''.

    Uses sorted-determinism: rows are emitted in insertion order; within tests
    the generator emits in stable order so two runs match byte-for-byte.
    """
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    for row in rows:
        writer.writerow([_coerce_csv(row.get(col)) for col in columns])
    data = buf.getvalue().encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 so gzip headers are deterministic across runs.
    with gzip.GzipFile(filename=str(path), mode="wb", mtime=0) as gz:
        gz.write(data)


# --------------------------------------------------------------------------
# Date / cadence helpers
# --------------------------------------------------------------------------
def is_holiday(d: datetime, holidays: set[str]) -> bool:
    return d.strftime("%Y-%m-%d") in holidays


def next_workday(d: datetime, holidays: set[str], rng: random.Random, weekend_skip_p: float) -> datetime:
    """Advance d by one or more days, mostly skipping weekends and holidays."""
    while True:
        d = d + timedelta(days=1)
        if is_holiday(d, holidays):
            continue
        if d.weekday() >= 5 and rng.random() < weekend_skip_p:
            continue
        return d


def burst_dates(
    start: datetime,
    end: datetime,
    n: int,
    chemists: list[str],
    holidays: set[str],
    rng: random.Random,
) -> list[tuple[datetime, str]]:
    """Spread n entries across [start, end] with bursty milestones, weekend
    gaps, holiday gaps. Returns list of (timestamp, chemist_email)."""
    span = (end - start).total_seconds()
    if span <= 0 or n == 0:
        return []
    out: list[tuple[datetime, str]] = []
    n_milestones = max(3, n // 60)
    milestones = sorted(
        start + timedelta(seconds=rng.uniform(0, span)) for _ in range(n_milestones)
    )
    for i in range(n):
        if rng.random() < 0.55 and milestones:
            anchor = milestones[i % len(milestones)]
            jitter_h = rng.gauss(0, 36)  # 1.5 days
            ts = anchor + timedelta(hours=jitter_h)
        else:
            ts = start + timedelta(seconds=rng.uniform(0, span))
        if ts < start:
            ts = start
        if ts > end:
            ts = end
        if is_holiday(ts, holidays):
            ts = ts + timedelta(days=1)
        if ts.weekday() >= 5 and rng.random() < 0.92:
            ts = ts + timedelta(days=2)
        ts = ts.replace(
            hour=rng.randint(8, 18),
            minute=rng.choice([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]),
            second=rng.randint(0, 59),
            microsecond=0,
        )
        chemist = chemists[i % len(chemists)]
        out.append((ts, chemist))
    out.sort(key=lambda x: x[0])
    return out


# --------------------------------------------------------------------------
# Generator orchestration
# --------------------------------------------------------------------------
def generate(world: dict[str, Any], seed: int) -> GenState:
    state = GenState()
    rng = random.Random(seed)

    # ---- projects ----
    project_records: list[dict[str, Any]] = []
    for p in world["projects"]:
        pid = stable_uuid("project", p["code"])
        row = {
            "id": pid,
            "code": p["code"],
            "name": p["name"],
            "therapeutic_area": p["therapeutic_area"],
            "started_at": iso(parse_iso(p["started_at"])),
            "ended_at": iso(parse_iso(p["ended_at"])),
            "pi_email": p["pi_email"],
            "metadata": jstr({"source": "mock_eln", "chemists": p["chemists"]}),
            "created_at": iso(parse_iso(p["started_at"])),
            "updated_at": iso(parse_iso(p["started_at"])),
        }
        state.add("projects", row)
        project_records.append({**p, "_id": pid, "_row": row})

    # ---- methods (global pool) ----
    method_ids: list[str] = []
    for m in world["methods"]:
        mid = stable_uuid("method", m["code"])
        method_ids.append(mid)
        state.add(
            "methods",
            {
                "id": mid,
                "code": m["code"],
                "name": m["name"],
                "instrument_kind": m.get("instrument_kind"),
                "description": m.get("description"),
                "parameters": jstr({"mock": True}),
                "created_at": iso(parse_iso(world["timing"]["global_started_at"])),
            },
        )

    # ---- families lookup ----
    families: dict[str, dict[str, Any]] = {f["name"]: f for f in world["chemistry_families"]}
    bonuses: dict[str, dict[str, dict[str, float]]] = world.get("condition_bonuses", {})
    pools: dict[str, list[Any]] = world["condition_pools"]
    holidays = set(world["timing"]["holiday_gap_dates"])

    # ---- per project chemistry: notebooks + reactions + compounds ----
    project_notebooks, project_compounds, project_reactions = emit_per_project_chemistry(
        state, project_records, families, stable_uuid, iso, parse_iso, jstr, rng
    )

    # ---- OFAT campaign reaction setup ----
    ofat_campaigns_index = setup_ofat_reactions(
        state, world, project_reactions, families,
        stable_uuid, iso, parse_iso, jstr, rng,
    )

    # ---- Entries: OFAT children + discovery. ----
    proj_entry_targets = {p["code"]: p["entries"] for p in world["projects"]}
    proj_ofat_count = {p["code"]: 0 for p in world["projects"]}
    for camp in world["ofat_campaigns"]:
        proj_ofat_count[camp["project_code"]] += camp["entry_count"]

    distrib_shape = world["distributions"]["entry_shape"]
    distrib_quality = world["distributions"]["data_quality_tier"]
    distrib_freetext = world["distributions"]["freetext_length_band"]
    distrib_quality_text = world["distributions"]["freetext_quality"]

    proj_discovery_count = {
        p["code"]: max(0, proj_entry_targets[p["code"]] - proj_ofat_count[p["code"]])
        for p in world["projects"]
    }
    total_entries = sum(proj_entry_targets.values())

    # Pre-assign distributions once across the whole population so global
    # ratios are tight.
    shape_assignments = dist_assign(rng, total_entries, distrib_shape)
    quality_assignments = dist_assign(rng, total_entries, distrib_quality)
    freetext_assignments = dist_assign(rng, total_entries, distrib_freetext)
    freetext_quality_assignments = dist_assign(rng, total_entries, distrib_quality_text)

    # OFAT entries first — they share a reaction_id within campaign.
    entry_index = emit_ofat_entries(
        state, world, ofat_campaigns_index, project_notebooks,
        shape_assignments, quality_assignments,
        freetext_assignments, freetext_quality_assignments,
        entry_index_start=0,
        families=families, bonuses=bonuses, pools=pools, holidays=holidays,
        adversarial_rate=ADVERSARIAL_RATE,
        stable_uuid=stable_uuid, iso=iso, parse_iso=parse_iso, jstr=jstr,
        burst_dates=burst_dates, rng=rng,
    )

    # Discovery entries.
    entry_index = emit_discovery_entries(
        state, world, project_notebooks, project_reactions,
        proj_discovery_count,
        shape_assignments, quality_assignments,
        freetext_assignments, freetext_quality_assignments,
        entry_index_start=entry_index,
        families=families, bonuses=bonuses, pools=pools, holidays=holidays,
        adversarial_rate=ADVERSARIAL_RATE,
        stable_uuid=stable_uuid, iso=iso, parse_iso=parse_iso, jstr=jstr,
        burst_dates=burst_dates, rng=rng,
    )

    # ---- Samples + results + attachments + audit_trail ----
    emit_derived_data(
        state, world, project_compounds, method_ids, seed,
        stable_uuid=stable_uuid, jstr=jstr,
    )

    # Sort each table by id for byte-identical output across runs.
    for tname in TABLE_ORDER:
        if tname in state.rows:
            state.rows[tname].sort(key=lambda r: r["id"])

    return state


# --------------------------------------------------------------------------
# SQL loader emission
# --------------------------------------------------------------------------
def write_seed_sql(out_path: Path, fixtures_relpath: str) -> None:
    """Write db/seed/20_mock_eln_data.sql.

    The loader is gated by `current_setting('app.mock_eln_enabled', true) = 'on'`.
    Re-running yields the same rows: the gated block TRUNCATEs mock_eln tables
    (CASCADE) inside the gated block, then \\copies.

    Defensive: ``fixtures_relpath`` is restricted to a safe character class
    before being interpolated into the ``\\copy ... FROM PROGRAM`` line so a
    future caller passing a path with shell metacharacters can't yield
    malformed SQL. Current callers (run() and tests) only pass paths
    derived from ``REPO_ROOT.relative_to`` or ``str(absolute_path)``, so
    this is purely a belt-and-braces guard.
    """
    if not _REL_PATH_RE.match(fixtures_relpath):
        raise ValueError(
            f"fixtures_relpath {fixtures_relpath!r} contains characters outside "
            f"the safe pattern {_REL_PATH_RE.pattern!r}"
        )
    lines: list[str] = [
        "-- Mock ELN — seed data loader.",
        "-- Auto-generated by services/mock_eln/seed/generator.py.",
        "-- DO NOT EDIT BY HAND. Re-run the generator instead.",
        "--",
        "-- Gating: this loader only runs when the postgres GUC",
        "--   app.mock_eln_enabled = 'on'",
        "-- is set on the session or the database.",
        "--",
        "-- Apply with:",
        "--   psql -v ON_ERROR_STOP=1 \\",
        "--     -c \"SET app.mock_eln_enabled = 'on';\" \\",
        "--     -f db/seed/20_mock_eln_data.sql",
        "-- or set it persistently:",
        "--   ALTER DATABASE chemclaw SET app.mock_eln_enabled = 'on';",
        "--",
        "-- Re-running is safe: the gated block TRUNCATEs the mock_eln tables",
        "-- (CASCADE) before \\copying so the resulting state is byte-identical",
        "-- to a fresh run with the same fixtures.",
        "",
        r"\set ON_ERROR_STOP on",
        "",
        "-- Resolve the gate into a psql boolean variable. \\if accepts only",
        "-- a literal boolean, so we compute the comparison server-side and",
        "-- \\gset the resulting true/false into :mock_eln_enabled.",
        "SELECT (coalesce(current_setting('app.mock_eln_enabled', true), 'off') = 'on')",
        "       AS mock_eln_enabled \\gset",
        "",
        r"\if :mock_eln_enabled",
        "BEGIN;",
        "",
        "TRUNCATE TABLE mock_eln.audit_trail, mock_eln.results, mock_eln.samples,",
        "               mock_eln.entry_attachments, mock_eln.entries,",
        "               mock_eln.reactions, mock_eln.compounds, mock_eln.methods,",
        "               mock_eln.notebooks, mock_eln.projects RESTART IDENTITY CASCADE;",
        "",
    ]

    for table in TABLE_ORDER:
        cols = COLUMNS[table]
        cols_sql = ", ".join(cols)
        rel = f"{fixtures_relpath}/{table}.copy.gz"
        lines.append(
            f"\\copy mock_eln.{table} ({cols_sql}) FROM PROGRAM 'gunzip -c {rel}' WITH (FORMAT csv, NULL '');"
        )

    lines.extend(
        [
            "",
            "COMMIT;",
            "",
            r"\echo 'Mock ELN seed data loaded.'",
            r"\else",
            r"\echo 'Mock ELN seed skipped — set app.mock_eln_enabled = ''on'' to load.'",
            r"\endif",
            "",
        ]
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------
def run(seed: int | None = None, fixtures_dir: Path | None = None,
        seed_sql_path: Path | None = None) -> dict[str, int]:
    """Generate fixtures + seed loader; returns row counts per table."""
    seed_val = seed if seed is not None else int(os.environ.get("WORLD_SEED", "42"))
    fdir = fixtures_dir or FIXTURES_DIR
    sql_path = seed_sql_path or SEED_SQL_PATH

    with open(WORLD_YAML, encoding="utf-8") as fh:
        world = yaml.safe_load(fh)

    state = generate(world, seed_val)

    # Write COPY files
    counts: dict[str, int] = {}
    for table in TABLE_ORDER:
        rows = state.rows.get(table, [])
        out = fdir / f"{table}.copy.gz"
        write_csv_gz(out, COLUMNS[table], rows)
        counts[table] = len(rows)

    # Write loader SQL. For the canonical (in-tree) layout the path in the
    # SQL file is repo-root-relative; for tests we accept any out-of-tree
    # fixtures dir and emit an absolute path.
    try:
        rel = fdir.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        rel = str(fdir)
    write_seed_sql(sql_path, rel)

    return counts


if __name__ == "__main__":
    counts = run()
    for t, n in counts.items():
        print(f"{t:25s} {n:>6d}")
