"""Deterministic seed generator for the ``fake_logs`` schema.

Run as a module from the repo root:

    python -m services.mock_eln.seed.fake_logs_generator

Reads ``WORLD_SEED`` (default 42) and writes:

- ``test-fixtures/fake_logs/world-default/persons.csv``
- ``test-fixtures/fake_logs/world-default/datasets.csv``
- ``test-fixtures/fake_logs/world-default/tracks.csv``
- ``test-fixtures/fake_logs/world-default/dataset_files.csv``

The companion SQL loader at ``db/seed/21_fake_logs_data.sql`` resolves
those CSVs and ``\\copy``s them into ``fake_logs.*``.

Design choices:

- Sample IDs follow ``S-{PROJECT_CODE}-{NNNNN}`` (zero-padded), matching
  the convention shared with the ELN seed builder so the cross-source
  scenarios traverse ``mock_eln.samples.sample_code`` ↔ ``fake_logs.datasets.sample_id``.
- 3000 datasets distributed 60% HPLC / 20% NMR / 15% MS / 5% other (split
  across GC-MS / LC-MS / IR).
- ~70% of datasets carry a sample_id; the remainder leave ``sample_id``
  NULL (system-test runs, blanks, etc.). Determinism: index modulo 10
  drives the assignment band so the choice is stable across runs.
- Tracks: HPLC and LC-MS datasets get one UV/TIC track with a small peak
  bag; NMR/MS/IR datasets keep tracks empty. ~1500 track rows total when
  combined with multi-track HPLC datasets that get a second DAD track.
- Persons: 50 deterministic operators; ``operator`` field on datasets is
  drawn from this pool.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# --------------------------------------------------------------------------
# Static config — kept here so the generator is import-free at module load.
# --------------------------------------------------------------------------
PROJECT_CODES: list[str] = ["NCE-1234", "NCE-5678", "GEN-9999", "FOR-1111"]

# Per-project sample-code count. Total ~3000 — matches the plan §"samples
# (~3000 in seed)" target. The seed builder for mock_eln uses the same
# convention; if those numbers diverge, the cross-link integrity check
# (≥1500 overlapping rows) still has plenty of headroom.
SAMPLES_PER_PROJECT: dict[str, int] = {
    "NCE-1234": 900,
    "NCE-5678": 400,
    "GEN-9999": 1200,
    "FOR-1111": 500,
}

INSTRUMENT_KINDS_DISTRIBUTION: list[tuple[str, float]] = [
    ("HPLC", 0.60),
    ("NMR", 0.20),
    ("MS", 0.15),
    ("GC-MS", 0.025),
    ("LC-MS", 0.020),
    ("IR", 0.005),
]

NUM_DATASETS = 3000
NUM_PERSONS = 50
SAMPLE_ASSIGN_BAND_FRACTION = 0.70  # ~70% of datasets carry a sample_id

CITATION_URI_TEMPLATE = "local-mock-logs://logs/dataset/{uid}"

# Output paths.
REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO_ROOT / "test-fixtures" / "fake_logs" / "world-default"
# When the mock_eln seed-builder fixture is present, my generator pulls
# sample_codes directly from it so the cross-link integrity check (≥1500
# fake_logs.datasets.sample_id matching mock_eln.samples.sample_code)
# holds end-to-end without coordinating string formats.
MOCK_ELN_SAMPLES_FIXTURE = (
    REPO_ROOT / "test-fixtures" / "mock_eln" / "world-default" / "samples.copy.gz"
)


def _now_minus_days(now: datetime, days: int) -> datetime:
    return now - timedelta(days=days)


def _fallback_sample_code(project: str, idx: int) -> str:
    """Synthetic sample-code generator used only when the mock_eln fixture
    is unavailable. Format mirrors the convention shared with the ELN seed
    builder so a one-off run still produces plausible identifiers.
    """
    return f"S-{project}-{idx:05d}"


def _load_mock_eln_sample_codes(path: Path = MOCK_ELN_SAMPLES_FIXTURE) -> list[str]:
    """Read the mock_eln samples fixture and return the unique sample_codes.

    The fixture is a gzipped Postgres COPY-style CSV; the third column is
    ``sample_code``. Returns ``[]`` if the file is missing so callers fall
    back to the synthetic generator.
    """
    if not path.exists():
        return []
    codes: list[str] = []
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split(",")
            if len(parts) < 3:
                continue
            codes.append(parts[2])
    return codes


def _generate_persons(rng: random.Random) -> list[dict]:
    first_names = [
        "Alice", "Ben", "Carol", "Dave", "Erin", "Frank", "Gina", "Henry",
        "Ivy", "Jack", "Kara", "Luis", "Mara", "Nina", "Oscar", "Priya",
        "Quinn", "Riya", "Sam", "Tara", "Uma", "Vince", "Wren", "Xena",
        "Yusuf", "Zara",
    ]
    last_names = [
        "Adams", "Brown", "Chen", "Diaz", "Evans", "Fox", "Gupta", "Hill",
        "Iyer", "Jones", "Kim", "Lopez", "Martin", "Nguyen", "Olsen",
        "Park", "Queen", "Rao", "Singh", "Thomas",
    ]
    persons: list[dict] = []
    seen: set[str] = set()
    i = 0
    while len(persons) < NUM_PERSONS:
        i += 1
        first = rng.choice(first_names)
        last = rng.choice(last_names)
        username = f"{first.lower()}.{last.lower()}{i:02d}"
        if username in seen:
            continue
        seen.add(username)
        persons.append(
            {
                "id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
                "username": username,
                "display_name": f"{first} {last}",
                "email": f"{username}@chemclaw.test",
                "metadata": json.dumps({"role": "operator"}),
            }
        )
    return persons


def _instrument_kind_for(idx: int, rng: random.Random) -> str:
    # Quantile-based assignment so the empirical distribution matches the
    # target tightly even at small sample sizes — matters because the
    # tests assert ±2pp on the HPLC/NMR/MS percentages.
    cumulative = 0.0
    quantile = (idx + 0.5) / NUM_DATASETS
    for kind, prob in INSTRUMENT_KINDS_DISTRIBUTION:
        cumulative += prob
        if quantile <= cumulative:
            return kind
    return INSTRUMENT_KINDS_DISTRIBUTION[-1][0]


def _build_uid(idx: int) -> str:
    return f"LOGS-{idx:06d}"


def _project_for(idx: int, rng: random.Random) -> str:
    # Distribute datasets across projects roughly proportional to their
    # sample budgets — chemists doing more lab work generate more
    # analytical datasets.
    weights = [SAMPLES_PER_PROJECT[p] for p in PROJECT_CODES]
    return rng.choices(PROJECT_CODES, weights=weights, k=1)[0]


def _sample_for(
    idx: int,
    project: str,
    rng: random.Random,
    *,
    sample_pool: list[str] | None = None,
) -> str | None:
    # Deterministic ~70% assignment — band is index-driven so the same
    # dataset always (or never) gets a sample_id. When ``sample_pool`` is
    # provided (loaded from the mock_eln fixture) we draw from it directly
    # so the resulting sample_id is guaranteed to exist in
    # ``mock_eln.samples.sample_code`` once both seeds load.
    #
    # IMPORTANT: the chosen sample MUST belong to ``project`` — the
    # dataset's ``project_code`` field is set to ``project`` in
    # ``_make_datasets_and_tracks``, and a mismatch (sample_id from
    # project A but project_code = project B) breaks every cross-source
    # filter scenario the agent runs. Filter the pool first.
    if (idx % 10) >= int(round(SAMPLE_ASSIGN_BAND_FRACTION * 10)):
        return None
    if sample_pool:
        # sample codes are S-{PROJECT}-{NNNNN}; the project segment may
        # itself contain a hyphen (e.g. NCE-1234), so reconstruct it as
        # everything between the leading "S-" and the trailing "-NNNNN".
        prefix = f"S-{project}-"
        in_project = [s for s in sample_pool if s.startswith(prefix)]
        if not in_project:
            # Defensive: should never happen for the four well-known
            # project codes, but if a future world.yaml introduces a
            # project the fixture doesn't cover yet we'd rather skip the
            # sample assignment than emit a cross-project mismatch.
            return None
        return rng.choice(in_project)
    project_size = SAMPLES_PER_PROJECT[project]
    sample_idx = (rng.randrange(project_size)) + 1
    return _fallback_sample_code(project, sample_idx)


def _method_name_for(kind: str, rng: random.Random) -> str:
    pools = {
        "HPLC": ["HPLC-A", "HPLC-B", "UPLC-A", "HPLC-PREP"],
        "NMR": ["1H-NMR", "13C-NMR", "DEPT", "COSY", "HSQC", "HMBC"],
        "MS": ["LCMS-A", "LCMS-B", "ICP"],
        "GC-MS": ["GCMS-A"],
        "LC-MS": ["LCMS-A", "LCMS-B"],
        "IR": ["IR-A"],
    }
    return rng.choice(pools[kind])


def _instrument_serial(kind: str, rng: random.Random) -> str:
    prefix = {
        "HPLC": "WATERS",
        "NMR": "BRUKER",
        "MS": "AGILENT",
        "GC-MS": "AGILENT",
        "LC-MS": "WATERS",
        "IR": "THERMO",
    }[kind]
    return f"{prefix}-{rng.randrange(1000, 9999):04d}"


def _parameters_for(kind: str, rng: random.Random) -> dict:
    if kind in ("HPLC", "LC-MS"):
        return {
            "flow_rate_ml_min": round(rng.uniform(0.4, 1.5), 2),
            "column": rng.choice(["BEH C18", "HSS T3", "CSH C18"]),
            "column_temp_c": rng.choice([30, 40, 50]),
            "gradient_min": rng.choice([5, 10, 15, 20]),
            "detection_nm": rng.choice([210, 254, 280]),
        }
    if kind == "NMR":
        return {
            "field_mhz": rng.choice([300, 400, 500, 600]),
            "solvent": rng.choice(["CDCl3", "DMSO-d6", "D2O", "MeOD"]),
            "scans": rng.choice([8, 16, 32, 128]),
        }
    if kind in ("MS", "GC-MS"):
        return {
            "ionization": rng.choice(["EI", "ESI+", "ESI-"]),
            "mass_range_min": 50,
            "mass_range_max": rng.choice([500, 1000, 2000]),
        }
    return {"mode": "ATR", "scans": rng.choice([16, 32, 64])}


def _peaks_for(kind: str, rng: random.Random, n: int = 4) -> list[dict]:
    if kind in ("HPLC", "LC-MS"):
        return [
            {
                "rt_min": round(rng.uniform(0.5, 12.0), 3),
                "area": round(rng.uniform(100, 100_000), 1),
                "height": round(rng.uniform(50, 50_000), 1),
                "name": f"peak-{i + 1}",
            }
            for i in range(n)
        ]
    if kind in ("MS", "GC-MS"):
        return [
            {
                "m_z": round(rng.uniform(80, 600), 4),
                "intensity": round(rng.uniform(1e3, 1e6), 1),
            }
            for i in range(n)
        ]
    return []


def _make_datasets_and_tracks(
    rng: random.Random,
    persons: list[dict],
    *,
    sample_pool: list[str] | None = None,
) -> tuple[list[dict], list[dict], list[dict]]:
    datasets: list[dict] = []
    tracks: list[dict] = []
    files: list[dict] = []
    base_now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)

    for idx in range(NUM_DATASETS):
        kind = _instrument_kind_for(idx, rng)
        project = _project_for(idx, rng)
        sample = _sample_for(idx, project, rng, sample_pool=sample_pool)
        uid = _build_uid(idx)
        operator = rng.choice(persons)["username"]
        method = _method_name_for(kind, rng)
        # 18-month spread, keyed off idx so the keyset pagination tests have
        # predictable strict-ordering when measured_at ties happen.
        measured_at = base_now - timedelta(
            minutes=idx * 7,  # ~7 min per dataset → spans ~14 days at the head
            days=rng.randrange(0, 540),
        )
        datasets.append(
            {
                "uid": uid,
                "name": f"{kind} {method} run {idx + 1}",
                "instrument_kind": kind,
                "instrument_serial": _instrument_serial(kind, rng),
                "method_name": method,
                "sample_id": sample,
                "sample_name": (
                    f"lot-{(idx % 50) + 1:03d}" if sample is not None else None
                ),
                "operator": operator,
                "measured_at": measured_at.isoformat(),
                "parameters_jsonb": json.dumps(_parameters_for(kind, rng)),
                "project_code": project,
                "citation_uri": CITATION_URI_TEMPLATE.format(uid=uid),
                "metadata": json.dumps({"backend": "fake-postgres"}),
            }
        )

        # Tracks — only ~half of HPLC datasets carry a track (the rest are
        # raw chromatograms with extraction deferred to Phase 2). LC-MS and
        # MS datasets always get one TIC track. Total works out to ~1500
        # which matches the plan's track-row target.
        if kind == "HPLC" and idx % 2 == 0:
            n_tracks = 2 if (idx % 8 == 0) else 1
            for t_idx in range(n_tracks):
                tracks.append(
                    {
                        "id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
                        "dataset_uid": uid,
                        "track_index": t_idx,
                        "detector": "UV" if t_idx == 0 else "DAD",
                        "unit": "mAU",
                        "peaks_jsonb": json.dumps(_peaks_for(kind, rng)),
                        "metadata": json.dumps({}),
                    }
                )
        elif kind in ("LC-MS", "MS", "GC-MS"):
            tracks.append(
                {
                    "id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
                    "dataset_uid": uid,
                    "track_index": 0,
                    "detector": "TIC",
                    "unit": "counts",
                    "peaks_jsonb": json.dumps(_peaks_for(kind, rng)),
                    "metadata": json.dumps({}),
                }
            )

        # File metadata — every dataset has one binary placeholder.
        files.append(
            {
                "id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
                "dataset_uid": uid,
                "filename": f"{uid}.raw",
                "mime_type": "application/octet-stream",
                "size_bytes": rng.randrange(10_000, 5_000_000),
                "description": f"{kind} raw data",
                "uri": CITATION_URI_TEMPLATE.format(uid=uid) + "/raw",
            }
        )

    return datasets, tracks, files


# --------------------------------------------------------------------------
# CSV writer — a thin wrapper that NULL-encodes empty strings via
# ``\N`` so PostgreSQL ``COPY ... FROM 'file' WITH (FORMAT csv, NULL '')``
# leaves columns NULL rather than empty-string. Header included so the SQL
# loader can pin column ordering.
# --------------------------------------------------------------------------
def _write_csv(path: Path, rows: list[dict], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            normalised = {
                col: ("" if row.get(col) is None else row[col]) for col in columns
            }
            writer.writerow(normalised)


def generate(
    seed: int = 42,
    out_dir: Path | None = None,
    *,
    mock_eln_samples_fixture: Path | None = None,
) -> dict[str, int]:
    """Generate fixtures into ``out_dir`` (default ``FIXTURE_DIR``).

    ``mock_eln_samples_fixture`` overrides the path the cross-link sample
    pool is loaded from (default: the checked-in ``test-fixtures/mock_eln/
    world-default/samples.copy.gz``). Tests that produce mock_eln fixtures
    in a temp dir use this to assert cross-link integrity end-to-end.

    Returns a count summary keyed by ``persons``, ``datasets``, ``tracks``,
    ``dataset_files`` for tests / smoke-checks.
    """
    rng = random.Random(seed)
    target_dir = out_dir or FIXTURE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)

    sample_pool = _load_mock_eln_sample_codes(
        mock_eln_samples_fixture or MOCK_ELN_SAMPLES_FIXTURE
    )
    persons = _generate_persons(rng)
    datasets, tracks, files = _make_datasets_and_tracks(
        rng, persons, sample_pool=sample_pool or None
    )

    _write_csv(
        target_dir / "persons.csv",
        persons,
        ["id", "username", "display_name", "email", "metadata"],
    )
    _write_csv(
        target_dir / "datasets.csv",
        datasets,
        [
            "uid",
            "name",
            "instrument_kind",
            "instrument_serial",
            "method_name",
            "sample_id",
            "sample_name",
            "operator",
            "measured_at",
            "parameters_jsonb",
            "project_code",
            "citation_uri",
            "metadata",
        ],
    )
    _write_csv(
        target_dir / "tracks.csv",
        tracks,
        ["id", "dataset_uid", "track_index", "detector", "unit", "peaks_jsonb", "metadata"],
    )
    _write_csv(
        target_dir / "dataset_files.csv",
        files,
        ["id", "dataset_uid", "filename", "mime_type", "size_bytes", "description", "uri"],
    )

    return {
        "persons": len(persons),
        "datasets": len(datasets),
        "tracks": len(tracks),
        "dataset_files": len(files),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate fake_logs fixtures.")
    parser.add_argument(
        "--seed",
        type=int,
        default=int(os.environ.get("WORLD_SEED", "42")),
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=FIXTURE_DIR,
    )
    args = parser.parse_args(argv)
    counts = generate(seed=args.seed, out_dir=args.out_dir)
    print(json.dumps(counts, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
