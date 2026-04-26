"""Sanity tests for the mock-ELN seed generator.

These tests run the generator against a temporary directory (no Postgres
needed) and assert the row counts and distribution shapes match the spec
in services/mock_eln/seed/world.yaml + the design plan.

Run:
    pytest services/mock_eln/seed/tests/

Determinism: both `test_determinism_byte_identical` and the count tests use
WORLD_SEED=42 (the default) so they assert against the canonical world.
"""

from __future__ import annotations

import gzip
from collections import Counter
from pathlib import Path

import pytest

from services.mock_eln.seed import generator as gen


@pytest.fixture(scope="module")
def generated(tmp_path_factory: pytest.TempPathFactory) -> dict[str, int]:
    fdir = tmp_path_factory.mktemp("fixtures")
    sql_path = tmp_path_factory.mktemp("sql") / "20_mock_eln_data.sql"
    counts = gen.run(seed=42, fixtures_dir=fdir, seed_sql_path=sql_path)
    # attach paths to the dict for test access
    counts["__fixtures_dir__"] = fdir  # type: ignore[assignment]
    counts["__sql_path__"] = sql_path  # type: ignore[assignment]
    return counts


def _read_table(fdir: Path, table: str) -> list[list[str]]:
    """Read a CSV.gz fixture file as list-of-lists. Bare csv parsing — the
    fixture format is CSV with NULL=empty string."""
    import csv as _csv

    path = fdir / f"{table}.copy.gz"
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        reader = _csv.reader(fh)
        return list(reader)


def _col_index(table: str, col: str) -> int:
    return gen.COLUMNS[table].index(col)


# --------------------------------------------------------------------------
# Row counts
# --------------------------------------------------------------------------


def test_projects_exact_count(generated: dict[str, int]) -> None:
    assert generated["projects"] == 4


def test_entries_at_least_2000(generated: dict[str, int]) -> None:
    assert generated["entries"] >= 2000, f"got {generated['entries']}"


def test_reactions_about_150(generated: dict[str, int]) -> None:
    # Allow some slack: 150 base + a few OFAT-only family additions.
    assert 140 <= generated["reactions"] <= 175, (
        f"reactions out of band: {generated['reactions']}"
    )


def test_samples_about_3000(generated: dict[str, int]) -> None:
    # The generator caps at 3000; allow a small under-shoot if early entries
    # rolled "0 samples". We require ≥ 2500.
    assert 2500 <= generated["samples"] <= 3050, (
        f"samples out of band: {generated['samples']}"
    )


def test_results_about_5000(generated: dict[str, int]) -> None:
    assert 4500 <= generated["results"] <= 5050, (
        f"results out of band: {generated['results']}"
    )


def test_attachments_about_3500(generated: dict[str, int]) -> None:
    assert 3000 <= generated["entry_attachments"] <= 3550, (
        f"attachments out of band: {generated['entry_attachments']}"
    )


def test_audit_about_12000(generated: dict[str, int]) -> None:
    assert 10000 <= generated["audit_trail"] <= 12050, (
        f"audit_trail out of band: {generated['audit_trail']}"
    )


# --------------------------------------------------------------------------
# Distribution checks
# --------------------------------------------------------------------------


def _pct(c: Counter, total: int, key: str) -> float:
    return 100.0 * c.get(key, 0) / total if total else 0.0


def test_entry_shape_distribution_within_2pp(generated: dict[str, int]) -> None:
    fdir = generated["__fixtures_dir__"]  # type: ignore[index]
    rows = _read_table(fdir, "entries")
    idx = _col_index("entries", "entry_shape")
    c = Counter(r[idx] for r in rows)
    total = sum(c.values())
    assert abs(_pct(c, total, "mixed") - 80.0) < 2.0, c
    assert abs(_pct(c, total, "pure-structured") - 7.0) < 2.0, c
    assert abs(_pct(c, total, "pure-freetext") - 8.0) < 2.0, c


def test_data_quality_tier_distribution_within_2pp(generated: dict[str, int]) -> None:
    fdir = generated["__fixtures_dir__"]  # type: ignore[index]
    rows = _read_table(fdir, "entries")
    idx = _col_index("entries", "data_quality_tier")
    c = Counter(r[idx] for r in rows)
    total = sum(c.values())
    assert abs(_pct(c, total, "clean") - 50.0) < 2.0, c
    assert abs(_pct(c, total, "partial") - 25.0) < 2.0, c
    assert abs(_pct(c, total, "noisy") - 15.0) < 2.0, c
    assert abs(_pct(c, total, "failed") - 10.0) < 2.0, c


# --------------------------------------------------------------------------
# OFAT campaign counts
# --------------------------------------------------------------------------


def test_ofat_campaigns_have_configured_counts(generated: dict[str, int]) -> None:
    """Each OFAT campaign should have its configured entry count ±2.

    The generator stamps `fields_jsonb.campaign_id` on OFAT children so we
    grep for those in the entries fixture.
    """
    import json

    import yaml

    world_yaml = Path(gen.WORLD_YAML)
    world = yaml.safe_load(world_yaml.read_text())
    expected = {c["id"]: c["entry_count"] for c in world["ofat_campaigns"]}

    fdir = generated["__fixtures_dir__"]  # type: ignore[index]
    rows = _read_table(fdir, "entries")
    fields_idx = _col_index("entries", "fields_jsonb")

    counts: Counter[str] = Counter()
    for r in rows:
        try:
            fj = json.loads(r[fields_idx]) if r[fields_idx] else {}
        except json.JSONDecodeError:
            continue
        cid = fj.get("campaign_id")
        if cid:
            counts[cid] += 1

    for cid, expect in expected.items():
        got = counts.get(cid, 0)
        assert abs(got - expect) <= 2, f"campaign {cid}: got {got}, expected {expect}"


# --------------------------------------------------------------------------
# Sample-code format (cross-link contract with fake_logs)
# --------------------------------------------------------------------------


def test_sample_code_format_is_s_project_ordinal(generated: dict[str, int]) -> None:
    """sample_code must be `S-{PROJECT_CODE}-{NNNNN}` (5-digit zero-padded).

    fake_logs.datasets cross-links via this exact format. If you change it,
    coordinate with the logs-mcp-builder first — the cross-link integrity
    test (≥1500 datasets matching a samples.sample_code) breaks otherwise.
    """
    import re

    fdir = generated["__fixtures_dir__"]  # type: ignore[index]
    rows = _read_table(fdir, "samples")
    code_idx = _col_index("samples", "sample_code")
    pattern = re.compile(r"^S-(NCE-1234|NCE-5678|GEN-9999|FOR-1111)-\d{5}$")
    bad = [r[code_idx] for r in rows if not pattern.match(r[code_idx])]
    assert not bad, f"sample_codes don't match S-PROJECT-NNNNN: {bad[:5]}"


# --------------------------------------------------------------------------
# Determinism
# --------------------------------------------------------------------------


def test_determinism_byte_identical(tmp_path: Path) -> None:
    """Re-run with the same seed + same fixtures_dir → byte-identical files.

    The SQL loader contains the fixtures path so two runs targeting different
    fixtures dirs would (correctly) produce different SQL. To assert true
    determinism we re-run into a single dir and check both invocations leave
    the same bytes on disk.
    """
    fdir = tmp_path / "fixtures"
    sql = tmp_path / "20_mock_eln_data.sql"
    gen.run(seed=42, fixtures_dir=fdir, seed_sql_path=sql)
    snapshot_files = {table: (fdir / f"{table}.copy.gz").read_bytes() for table in gen.TABLE_ORDER}
    snapshot_sql = sql.read_bytes()
    gen.run(seed=42, fixtures_dir=fdir, seed_sql_path=sql)
    for table in gen.TABLE_ORDER:
        b = (fdir / f"{table}.copy.gz").read_bytes()
        assert snapshot_files[table] == b, f"non-deterministic output for table {table}"
    assert sql.read_bytes() == snapshot_sql


# --------------------------------------------------------------------------
# Loader SQL is well-formed
# --------------------------------------------------------------------------


def test_seed_sql_contains_gating_and_copy(generated: dict[str, int]) -> None:
    sql_path = generated["__sql_path__"]  # type: ignore[index]
    text = Path(sql_path).read_text()
    assert "app.mock_eln_enabled" in text
    # Per-table \copy lines exist
    for table in gen.TABLE_ORDER:
        assert f"\\copy mock_eln.{table}" in text, f"missing \\copy for {table}"
    assert "TRUNCATE TABLE mock_eln" in text


# --------------------------------------------------------------------------
# Cross-link integrity (regression for bd1b7b2 / fake_logs project_code mismatch)
# --------------------------------------------------------------------------


def test_fake_logs_project_code_matches_sample_id_project(
    generated: dict[str, int], tmp_path: Path
) -> None:
    """Every fake_logs dataset that carries a sample_id must have a project_code
    that matches the project encoded in the sample_id.

    Regression: an earlier version of `_sample_for` (in fake_logs_generator)
    drew from `sample_pool` ignoring the `project` argument, so 68% of
    datasets ended up with project_code disagreeing with sample_id's project.
    The agent's "find HPLC results for samples in NCE-1234" scenarios all
    return the wrong rows when this regresses.
    """
    import csv as _csv
    from services.mock_eln.seed import fake_logs_generator as flg

    fdir = Path(generated["__fixtures_dir__"])  # type: ignore[index]
    samples_fixture = fdir / "samples.copy.gz"
    out_dir = tmp_path / "fake_logs"
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = flg.generate(
        seed=42,
        out_dir=out_dir,
        mock_eln_samples_fixture=samples_fixture,
    )
    assert counts["datasets"] == flg.NUM_DATASETS

    with (out_dir / "datasets.csv").open() as fh:
        rows = list(_csv.DictReader(fh))

    matched = mismatched = with_sample = 0
    for row in rows:
        sid = row.get("sample_id") or ""
        if not sid:
            continue
        with_sample += 1
        # sample_id is S-{PROJECT}-{NNNNN}; project may itself contain a
        # hyphen (NCE-1234), so reconstruct by stripping the leading 'S-'
        # and the trailing '-NNNNN'.
        parts = sid.split("-")
        if len(parts) < 4:
            continue
        sample_project = "-".join(parts[1:-1])
        if sample_project == row["project_code"]:
            matched += 1
        else:
            mismatched += 1

    assert with_sample > 0, "no datasets carry a sample_id (test fixture broken)"
    assert mismatched == 0, (
        f"{mismatched}/{with_sample} datasets have project_code disagreeing "
        f"with the project encoded in sample_id — cross-link bug regressed"
    )
    assert matched == with_sample
