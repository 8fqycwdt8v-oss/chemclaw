# Track B — Python Hotspots Deep Dive

**Date:** 2026-04-29
**Branch:** `refactor/wave1-audit` (worktree: `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit`)
**Scope:** Python God-files identified in PR-7 of `~/.claude/plans/develop-an-intense-code-happy-feather.md`.

| File | LOC | Concerns mixed | Risk class |
|---|---|---|---|
| `services/mock_eln/seed/generator.py` | 1135 | 7 (orchestration, RDKit chem, RNG state, CSV codec, SQL emission, file-IO, type plumbing) | MEDIUM (offline tool, but determinism is load-bearing for fixtures) |
| `services/mcp_tools/mcp_eln_local/main.py` | 969 | 6 (FastAPI bootstrap, settings, pool lifecycle, Pydantic models, SQL builders, row mappers, route handlers) | MEDIUM (read-only, no RLS coupling, dev sentinel in DSN) |
| `services/mcp_tools/mcp_doc_fetcher/main.py` | 728 | 6 (URI parsing, SSRF/IP allow-list, file-jail, HTTPS streaming, PDF rendering, byte-offset → page) | HIGH (network egress + raw bytes, four `# type: ignore`, latent unbound-name bug in `/pdf_pages`) |

The shared factory `services/mcp_tools/common/app.py` (304 LOC) and the comparison MCP `services/mcp_tools/mcp_xtb/main.py` (289 LOC) were skim-read for cross-file duplication context.

---

## File 1 — `services/mock_eln/seed/generator.py` (1135 LOC)

### Cohesion analysis

The file mixes seven top-level concerns under one orchestrator. Concrete line ranges below; each "helper" is a module-level `def` (not nested) unless noted.

| # | Concern | Line range | Top-level helpers |
|---|---|---|---|
| 1 | Module preamble: docstring, imports, repo-rooting, table/column manifests | `1` – `134` | constants only |
| 2 | Generic helpers: `stable_uuid`, `iso`, `parse_iso`, `jstr`, `weighted_pick`, `dist_assign` | `137` – `186` | 6 helpers |
| 3 | RDKit reaction expansion: `smarts_react`, `canonical_smiles`, `build_reaction_smiles` | `189` – `237` | 3 helpers |
| 4 | In-memory state: `GenState` dataclass | `240` – `253` | 1 dataclass + 2 methods |
| 5 | CSV/gzip codec: `_coerce_csv`, `write_csv_gz` | `256` – `287` | 2 helpers |
| 6 | Date/cadence: `is_holiday`, `next_workday`, `burst_dates` | `290` – `352` | 3 helpers |
| 7 | The mega-function `generate(world, seed) -> GenState` (≈ 650 LOC) — contains 4 nested loops and 2 closures (`sample_yield`, `pick_conditions`). | `360` – `1012` | **1 function** |
| 8 | SQL emission: `write_seed_sql` | `1020` – `1092` | 1 helper |
| 9 | Public entry point: `run` + `__main__` | `1100` – `1135` | 1 helper |

`generate()` alone is the textbook "God function." It does seven distinct things in sequence with shared mutable state (`state`, `entry_index`, four sub-RNGs `seed+1..+4`):

- L364–381 — projects rows
- L383–399 — methods rows
- L401–405 — families/bonuses/pools/holidays lookups
- L412–484 — per-project notebooks + compounds + canonical reactions (3 inner loops, ~73 LOC)
- L489–521 — OFAT campaigns: locate/synthesize one canonical reaction per campaign
- L524–548 — pre-assign distributions (`shape`, `quality`, `ftext_band`, `ftext_quality`)
- L550–574 — closures `sample_yield` and `pick_conditions`
- L577–697 — OFAT entries loop (~120 LOC, copies structured-vs-freetext-vs-mixed branching)
- L700–822 — Discovery entries loop (~122 LOC, **almost identical** branching duplicated from OFAT loop)
- L824–878 — Samples loop (`sample_rng`)
- L881–929 — Results loop (`result_rng`)
- L931–969 — Attachments loop (`att_rng`)
- L971–1005 — Audit-trail loop (`audit_rng`)
- L1007–1010 — final per-table sort

The OFAT and Discovery branches share roughly 80 lines of duplicated shape-handling — see `Duplication` subsection below.

### Proposed split (concrete)

The PR-7 proposal in the plan ("`generator.py` (orchestrator), `chemistry_families.py`, `ofat_campaigns.py`, `entry_shapes.py`") is directionally right but the natural seams in the code suggest a slightly different split that respects shared helpers. Concrete boundaries:

#### `services/mock_eln/seed/_helpers.py` (new, ~120 LOC)
- Lines to extract: `137` – `186` (generic helpers) and `256` – `287` (CSV/gzip codec) and `290` – `352` (date/cadence helpers).
- Public surface: `stable_uuid`, `iso`, `parse_iso`, `jstr`, `weighted_pick`, `dist_assign`, `write_csv_gz`, `is_holiday`, `next_workday`, `burst_dates`.
- Private: `_coerce_csv`.
- No cross-cutting state. Pure functions + `random.Random` injection.

#### `services/mock_eln/seed/chemistry.py` (new, ~80 LOC)
- Lines to extract: `189` – `237` (RDKit reaction expansion).
- Public surface: `smarts_react(smarts, reactants) -> str | None`, `canonical_smiles(s) -> str | None`, `build_reaction_smiles(family, rng) -> tuple[str, str | None, list[str]]`.
- This is the **only** module that imports `rdkit` in the seed path. Keeping it isolated means the orchestrator unit-tests don't need RDKit on the path, and the `chemistry.py` file becomes the natural place to land any future "real reactant pool" logic without polluting the orchestrator.

#### `services/mock_eln/seed/state.py` (new, ~30 LOC)
- Lines to extract: `240` – `253` (`GenState` dataclass).
- Public surface: `GenState` (dataclass with `add`, `count`).

#### `services/mock_eln/seed/projects_methods.py` (new, ~80 LOC)
- Lines to extract: the project-and-methods phase L364–399 plus the per-project notebooks/compounds/canonical-reactions phase L412–484, refactored as three pure functions.
- Public surface:
  - `seed_projects(state, world) -> list[dict]` (returns `project_records`).
  - `seed_methods(state, world) -> list[str]` (returns `method_ids`).
  - `seed_per_project(state, world, project_records, families, rng) -> tuple[dict, dict, dict]` (returns the three project_* maps currently built inline).
- Private helpers: `_compound_descriptors(smi)` for the RDKit MolToInchiKey/MolWt block at L444–450 (currently inline; trivially extractable).

#### `services/mock_eln/seed/entries.py` (new, ~250 LOC)
- Lines to extract: the entire entries-emission block L487–822 (OFAT + Discovery), plus the closures `sample_yield`/`pick_conditions` (L550–574) lifted to module-level pure functions taking `(families, bonuses, pools, rng)`.
- Public surface:
  - `compute_entry_distributions(world, total_entries, rng) -> tuple[list[str], list[str], list[str], list[str]]` (the four `dist_assign` calls at L543–546).
  - `emit_ofat_entries(state, world, ofat_index, project_notebooks, project_reactions, distributions, families, bonuses, pools, rng) -> int` (returns `entry_index` advance).
  - `emit_discovery_entries(state, world, project_notebooks, project_reactions, project_compounds_unused, distributions, entry_index_start, families, bonuses, pools, rng) -> int`.
- Private helper: `_render_entry_for_shape(shape, structured, conditions, ftext_fields, ftext_band, ftext_quality, quality, rng, *, adversarial) -> tuple[dict, str, int]` — the **three-way shape branch** at L634–670 and L764–795 that is currently duplicated. Folding it here removes ~80 lines.

#### `services/mock_eln/seed/derived.py` (new, ~150 LOC)
- Lines to extract: samples L824–878, results L881–929, attachments L931–969, audit trail L971–1005.
- Public surface: `emit_samples`, `emit_results`, `emit_attachments`, `emit_audit_trail`. Each takes `(state, seed, ...)` so the deterministic `random.Random(seed+N)` pattern stays explicit and reviewable.

#### `services/mock_eln/seed/sql_emitter.py` (new, ~80 LOC)
- Lines to extract: `1020` – `1092` (`write_seed_sql`).
- Public surface: `write_seed_sql(out_path, fixtures_relpath, table_order, columns)`.
- Move `TABLE_ORDER`/`COLUMNS` here too (they describe the SQL contract, not the generator state); the orchestrator imports them.

#### `services/mock_eln/seed/generator.py` (kept, ~120 LOC after split)
- Keep: lines `1` – `89` (docstring, paths, `TABLE_ORDER`, `COLUMNS` import), lines `1100` – `1135` (`run`, `__main__`).
- Replace `generate()` body with a sequenced call list:
  ```
  state = GenState()
  rng = random.Random(seed)
  records = seed_projects(state, world)
  method_ids = seed_methods(state, world)
  pn, pc, pr = seed_per_project(state, world, records, families, rng)
  ofat_index = seed_ofat_campaigns(state, world, pr, families, rng)
  distributions = compute_entry_distributions(world, sum(...), rng)
  idx = emit_ofat_entries(state, world, ofat_index, pn, pr, distributions, ...)
  emit_discovery_entries(state, world, pn, pr, pc, distributions, idx, ...)
  emit_samples(state, seed, world)  # uses random.Random(seed+1)
  emit_results(state, seed, method_ids)  # seed+2
  emit_attachments(state, seed)  # seed+3
  emit_audit_trail(state, seed)  # seed+4
  state.sort_by_id(TABLE_ORDER)
  ```
- The deterministic-seed contract becomes self-documenting: each phase declares the offset it consumes.

After split:
- `generator.py` ≤ 120 LOC.
- Largest file: `entries.py` ≈ 250 LOC (dominated by structured/freetext/mixed templating).
- Test seams: each phase is independently exerciseable with synthetic `world` fixtures and a fixed seed.

### Duplication across MCPs / inside the file

1. **OFAT vs Discovery shape-handling** is duplicated almost line-for-line:
   - OFAT branch L634–670 (37 lines) vs Discovery branch L764–795 (32 lines).
   - The `pure-structured` / `pure-freetext` / `mixed` branching is identical except for the `fields_jsonb = {"campaign_id": camp["id"]}` injection at L641 (OFAT-only). One helper with an optional `extra_fields` parameter covers both.
   - The `LENGTH_BANDS` lookup pattern `ft.LENGTH_BANDS[[b[0] for b in ft.LENGTH_BANDS].index(ftext_band)][1:]` (L642 and L662 and L770 and L788) is **four** copies of the same scan; should become `freetext_templates._band_for(name)` returning `(lo, hi)`.

2. **`status` / `signed_at` / `signed_by` derivation** duplicated at L672–674 (OFAT) and L797–799 (Discovery). Tiny but obvious; extract as `_compute_signature(rng, status_p_signed=0.55, *, signature_window_days=5)`.

3. **`fields_jsonb` quality perturbation** ("partial drops 30 % of conditions / noisy adds raw_remarks") duplicated at L651–661 (OFAT) and L778–787 (Discovery).

4. **`build_reaction_smiles` is also called inside `mcp_xtb/main.py`'s `_smiles_to_xyz`** (it isn't, but `Chem.MolFromSmiles` validation is). The seed generator at L444–450 (compound descriptors) and `mcp_xtb/main.py:63` and `mcp_rdkit/main.py:46–52` and `mcp_aizynth/main.py:71` and `mcp_askcos/main.py:78` and `mcp_chemprop/main.py:97` all re-invent the `mol = MolFromSmiles(smiles); if mol is None: raise ValueError(...)` pattern with subtly different error messages. PR-7 should land a `services/mcp_tools/common/chemistry.py` exporting `mol_from_smiles(smiles, *, max_len=MAX_SMILES_LEN)` and have all six call-sites use it. Cite: `mcp_rdkit/main.py:46-52`, `mcp_xtb/main.py:53-77`, `mcp_aizynth/main.py:71`, `mcp_askcos/main.py:78`, `mcp_chemprop/main.py:97`, `services/mock_eln/seed/generator.py:444-450`.

### `# type: ignore` / `Any` / type-safety

The file has zero `# type: ignore` lines. It does, however, type the entire JSON pipeline as `dict[str, Any]`:

| Site | Line | Current shape | Suggested fix |
|---|---|---|---|
| `stable_uuid(*parts: Any)` | 142 | `*parts: Any` | Restrict to `str | int | UUID` (the only inputs in practice). |
| `jstr(obj: Any)` | 156 | `Any` JSON serializer | Acceptable — JSON serializers are intrinsically `Any`. |
| `build_reaction_smiles(family: dict[str, Any], ...)` | 226 | untyped `family` | Define `class Family(TypedDict): name: str; smarts: str; fragment_pools: dict[str, list[str]]; base_yield_pct: float; yield_sigma: float`. |
| `GenState.rows: dict[str, list[dict[str, Any]]]` | 247 | row payloads `dict[str, Any]` | Acceptable — these are deliberately heterogeneous (different tables have different columns). The type hint should remain `dict[str, Any]`, but each `state.add("entries", ...)` call site could become `state.add_entry(EntryRow(...))` with a per-table TypedDict. ~10 typed dicts; high effort/medium reward. |
| `_coerce_csv(v: Any)` | 261 | OK for a CSV codec | Keep as is. |
| `write_csv_gz(rows: list[dict[str, Any]])` | 273 | OK | Keep. |
| `generate(world: dict[str, Any], seed: int) -> GenState` | 360 | untyped `world` | Add `class World(TypedDict)` matching `world.yaml`. Ten keys; would catch typos when editing the YAML. **High value, ~50 lines of additional types.** |
| Closures `sample_yield`/`pick_conditions` | 550, 563 | typed dict-of-Any | If lifted to module level (per the proposed split), tighten to `Mapping[str, str | float | int]`. |

Functions without explicit return types: every nested closure (lines 550, 563) has return types but no parameter mypy strictness. Acceptable.

The file does not enable `from __future__ import annotations` strictly speaking (it does, line 37) but is fine.

### SQL injection / RLS risks

The generator emits SQL **only via the `write_seed_sql` block** (L1020–1092). Concrete risks:

- The SQL template uses `\copy ... FROM PROGRAM 'gunzip -c {rel}' WITH (FORMAT csv, NULL '')` at line 1076. **`{rel}` is f-string interpolated**.
  - Origin of `{rel}`: `run()` at L1124 computes `rel = fdir.relative_to(REPO_ROOT).as_posix()`. The `fdir` parameter defaults to `FIXTURES_DIR` (a constant). Tests can pass a custom `fdir`; if a test (or future caller) passes a `fdir` containing a single quote or a shell metacharacter, the resulting SQL would contain executable shell because `\copy ... FROM PROGRAM ...` runs a shell command on the psql side.
  - Severity: LOW (current callers are tests and CI; no untrusted input ever flows into `fdir`). But the code is brittle — a relative path with a `'` in it produces malformed SQL.
  - **Suggested fix:** assert `re.match(r"^[A-Za-z0-9_./-]+$", rel)` in `write_seed_sql` before formatting; raise `ValueError` on anything else.
- All other SQL in the generator is via `\copy` to fixed table names and column lists from `COLUMNS[table]` (compile-time constants). Safe.
- The generator does **not** set `app.current_user_entra_id`. It doesn't need to: it writes directly to `mock_eln.*` tables which have no RLS (verified against `db/init/30_mock_eln_schema.sql:65` and `12_security_hardening.sql` — only the public-schema canonical tables are FORCE-RLS'd; `mock_eln.*` is gated by GRANT to `chemclaw_mock_eln_reader` only). No RLS bypass concern.

No raw `cursor.execute` / `psycopg.connect` / parameterised queries inside the generator — it's purely a fixture writer.

### Schema-coupling — generator vs `db/init/30_mock_eln_schema.sql`

Cross-checked the `COLUMNS` dict at L92–134 against the live schema:

| Table | Generator columns | Schema columns (DDL) | Match? |
|---|---|---|---|
| `projects` | id, code, name, therapeutic_area, started_at, ended_at, pi_email, metadata, created_at, updated_at | id, code, name, therapeutic_area, started_at, ended_at, pi_email, metadata, created_at, updated_at | OK |
| `notebooks` | id, project_id, name, kind, metadata, created_at, updated_at | same | OK (note: `kind CHECK` is enforced on insert; generator picks from `world.yaml` `notebook_kinds` — must produce only `discovery`/`process-dev`/`analytical`. World YAML has `discovery, process-dev, analytical` — verified.) |
| `methods` | id, code, name, instrument_kind, description, parameters, created_at | same | OK |
| `compounds` | id, smiles_canonical, inchikey, mw, external_id, project_id, metadata, created_at | same | OK |
| `reactions` | id, canonical_smiles_rxn, family, step_number, project_id, metadata, created_at | same | OK |
| `entries` | id, notebook_id, project_id, reaction_id, schema_kind, title, author_email, signed_by, status, entry_shape, data_quality_tier, fields_jsonb, freetext, freetext_length_chars, created_at, modified_at, signed_at | same + `freetext_tsv` (STORED GENERATED — schema generates it, COPY skips it correctly because the generator omits it from `COLUMNS["entries"]`) | OK |
| `entry_attachments` | id, entry_id, filename, mime_type, size_bytes, description, uri, created_at | same | OK |
| `samples` | id, entry_id, sample_code, compound_id, amount_mg, purity_pct, notes, created_at | same | OK (UNIQUE constraint on `sample_code` enforced at DB level since `30_mock_eln_schema.sql:265–275`; generator's `S-{PROJECT}-{NNNNN}` format guarantees uniqueness — verified at L863). |
| `results` | id, sample_id, method_id, metric, value_num, value_text, unit, measured_at, metadata, created_at | same | OK |
| `audit_trail` | id, entry_id, actor_email, action, field_path, old_value, new_value, reason, occurred_at | same | OK |

No drift detected. **Schema coupling is documented but not asserted at test time** — a future column rename in `30_mock_eln_schema.sql` without updating `COLUMNS` would manifest as a `\copy` failure at seed apply, not at generator-write time. **Recommendation:** add a unit test in `services/mock_eln/tests/` that introspects the live schema and asserts every key in `COLUMNS[table]` matches `information_schema.columns` for `mock_eln.<table>`. Cheap, catches the regression at PR time.

### Determinism

Re-running with the same `WORLD_SEED` is **claimed** byte-identical (docstring L9–11). I verified each potential non-determinism source:

| Source | Status | Evidence |
|---|---|---|
| `random.Random(seed)` for primary RNG | OK | L362; sub-RNGs `random.Random(seed+1..+4)` at L838, L882, L932, L972 — all explicit. |
| `datetime.now()` / `time.time()` / `today()` | None | grep returns no matches; the only datetime calls are `parse_iso` and `iso` formatting on rng-produced datetimes. The single `datetime.now(timezone.utc)` in the codebase is in `mcp_eln_local/main.py:472`, not the generator. |
| `uuid.uuid4` / non-deterministic UUID | None | `stable_uuid` at L142–144 wraps `uuid.uuid5(NAMESPACE, key)` where `NAMESPACE` is a hardcoded UUID at L68. All entity IDs derive from this. |
| `gzip` header timestamp | OK | L286 sets `mtime=0` explicitly so gzip output is byte-stable. |
| Dict-iteration order | OK | Python 3.7+ guarantees insertion order. Multiple sites materialise dicts via `list(d.keys())` (L162, L171, L230, L439, L654, L726, L780) before iterating, which is robust. **One exception**: the per-project loop at L412 iterates `project_records` in the order `world["projects"]` declares them (YAML preserves order via `yaml.safe_load` returning lists, OK), but `project_compounds`, `project_reactions`, and `project_notebooks` are populated keyed by `pcode` — later iterators rely on YAML order being preserved. Stable. |
| `set()` iteration | One concern | L405 builds `holidays = set(world["timing"]["holiday_gap_dates"])`. Iteration order of a `set` is hash-stable for strings (CPython implementation detail) but **not** part of the language guarantee. The set is only used in `is_holiday()` membership tests (L295–296), never iterated. Safe. |
| Final sort | OK | L1007–1010 sorts every emitted table by `id`, which is `stable_uuid(...)`-derived. Byte-identical regardless of insertion order. |
| RDKit non-determinism | Low risk | `Chem.MolFromSmiles` and `Chem.MolToSmiles(canonical=True)` are deterministic for a given RDKit version. The `EmbedMolecule(ETKDGv3())` call in `mcp_xtb` is non-deterministic but is **not** in the generator path. `MolToInchiKey` and `Descriptors.MolWt` (L446–447) are deterministic. The `RunReactants` call inside `smarts_react` (L202) **is** deterministic for a given reactant order (verified by RDKit docs); the generator builds reactants as `[rng.choice(pools[name]) for name in pool_names]` (L231), so the order is rng-determined. Safe. |
| Subprocess / OS file enumeration | None | No `os.listdir`, no `glob`, no `Path.iterdir`. |

**Verdict:** the generator's determinism claim is honoured. The only theoretical weakness is the docstring at L11 saying "UUIDs are derived from a deterministic seed" — they're derived from the **namespace UUID**, not from `seed`. Two runs with different `WORLD_SEED` still produce the **same** UUIDs for the same entity tuple (same project code → same project ID), which is a *feature* (cross-seed stable identity for tests) but the docstring should clarify.

**Recommendation:** add a CI check that hashes the gzipped output and compares against a committed checksum. Cheap regression net.

---

## File 2 — `services/mcp_tools/mcp_eln_local/main.py` (969 LOC)

### Cohesion analysis

Six concerns, with the "Pydantic models" and "endpoint handlers" blocks dominating:

| # | Concern | Line range | Helpers |
|---|---|---|---|
| 1 | Module preamble: docstring, imports, dev-sentinel guard | `1` – `61` | 0 |
| 2 | Settings (`ElnLocalSettings`) | `64` – `95` | 1 class |
| 3 | Pool lifecycle: `_pool_holder`, `_check_dsn_safety`, `_lifespan`, `_ready_check`, `_acquire` | `98` – `184` | 5 helpers |
| 4 | `create_app` invocation (single line, L186–193) | `186` – `193` | 0 |
| 5 | Pydantic models — domain types + request/response models, **plus** validators | `196` – `465` | 13 classes, ~12 validators |
| 6 | Helpers: `_valid_until_now`, `_*_citation_uri`, `_row_to_*`, `_encode_cursor`, `_decode_cursor` | `468` – `601` | 11 helpers |
| 7 | Endpoint handlers + per-route SQL: `experiments_query`, `_fetch_attachments`, `_fetch_audit_summary`, `experiments_fetch`, `reactions_query`, `reactions_fetch`, `samples_fetch`, `attachments_metadata`, `samples_by_entry` | `604` – `955` | 9 routes + 2 private helpers; **inline SQL in every route** |
| 8 | Local dev `__main__` | `958` – `969` | 0 |

The two main symptoms of the file's bloat: (a) every route hand-builds SQL in a Python list-of-strings and passes a `dict[str, Any]` of params; (b) the row-mapper helpers are conceptually closer to the Pydantic models but live 250 lines below them.

### Proposed split (concrete)

The plan calls for `main.py` / `routes.py` / `queries.py` / `models.py`. Refining with code evidence:

#### `services/mcp_tools/mcp_eln_local/settings.py` (new, ~40 LOC)
- Lines to extract: `54` – `95`.
- Public surface: `ElnLocalSettings`, the `_DEV_SENTINEL_PASSWORD` constant binding, `_check_dsn_safety` (currently L104).
- Justification: settings + bootstrap-time DSN validation belong together; both are run before pool creation.

#### `services/mcp_tools/mcp_eln_local/db.py` (new, ~80 LOC)
- Lines to extract: `98` – `184` (pool holder, `_lifespan`, `_ready_check`, `_acquire`).
- Public surface: `lifespan_factory(settings) -> async context manager`, `acquire(pool_holder) -> async context manager`, `ready_check(settings) -> bool`.
- The current `_pool_holder: dict[str, AsyncConnectionPool] = {}` is a module-level singleton. After the split it becomes a property of the lifespan context (or stays a module-level global in `db.py`); either way, hide it.

#### `services/mcp_tools/mcp_eln_local/models.py` (new, ~270 LOC)
- Lines to extract: `196` – `465` (the entire Pydantic + validator block).
- Plus: lift the row-mappers `_row_to_*` (L487–584) here as classmethods (`ElnEntry.from_row(row)`), which is the natural Pydantic idiom and removes two compat layers.
- Public surface: `ElnEntry`, `CanonicalReaction`, `CanonicalReactionDetail`, `Sample`, `Result`, `Attachment`, `AuditEntry`, all `*In` / `*Out` request/response shapes.
- Private: `_validate_id`, `_parse_iso` regex compile constants `_ID_RE`, `_PROJECT_CODE_RE`, `_FAMILY_RE`.

#### `services/mcp_tools/mcp_eln_local/queries.py` (new, ~250 LOC)
- Lines to extract: each route's SQL fragment + filter-building logic, refactored as pure functions returning `(sql_text, params_dict)`:
  - `build_experiments_query(req: ExperimentsQueryIn, cursor_ts, cursor_id, since_dt) -> tuple[str, dict]` — the L617–657 block.
  - `build_reactions_query(req: ReactionsQueryIn) -> tuple[str, dict]` — the L745–772 block.
  - `EXPERIMENTS_FETCH_SQL` (constant) — L716–725.
  - `REACTIONS_FETCH_SQL` (constant) — L792–801.
  - `OFAT_CHILDREN_SQL` (constant) — L820–836.
  - `ATTACHMENTS_BY_ENTRY_SQL`, `AUDIT_SUMMARY_SQL`, `SAMPLE_BY_ID_SQL`, `RESULTS_BY_SAMPLE_SQL`, `SAMPLES_BY_ENTRY_SQL`, `ENTRY_EXISTS_SQL`.
- Public surface: the builder functions and the SQL constants.
- Private: `_encode_cursor`, `_decode_cursor` (currently L587–601).

#### `services/mcp_tools/mcp_eln_local/routes.py` (new, ~280 LOC)
- Lines to extract: every `@app.post` block + its private fetch-helpers (`_fetch_attachments`, `_fetch_audit_summary`).
- Public surface: a `register_routes(app, settings)` function.
- Each handler shrinks to the orchestration shell:
  ```python
  async def experiments_query(req):
      since_dt = parse_iso_or_none(req.since)
      cursor_ts, cursor_id = decode_cursor_or_none(req.cursor)
      sql, params = build_experiments_query(req, cursor_ts, cursor_id, since_dt)
      async with acquire() as conn, conn.cursor() as cur:
          await cur.execute(sql, params)
          rows = await cur.fetchall()
      return materialize_query_page(rows, req.limit, encode_cursor)
  ```

#### `services/mcp_tools/mcp_eln_local/main.py` (kept, ~50 LOC)
- Imports settings, builds the FastAPI app via `create_app(...)`, calls `register_routes(app, settings)`. Hosts the `__main__` block.

After split:
- Largest file: `routes.py` ≈ 280 LOC (acceptable — endpoints are self-documenting).
- `models.py` becomes the single source of truth for the public response shape; downstream agent-claw builtins import from it via JSON-schema export only, so models can move freely.

### Duplication across MCPs

1. **`_acquire()` async-context-manager-with-DB-pool pattern** is unique to this file today, but the `mcp_logs_sciy/backends/fake_postgres.py:110-115` builds **its own** `psycopg.AsyncConnection.connect(...)` per call (no pool, no connection-busy guard). When `mcp_logs_sciy` graduates from one-call-per-request to a hot-path service it will re-implement this pattern. **Recommendation:** lift the `_acquire`+`_lifespan`+`_pool_holder` triple into `services/mcp_tools/common/db_pool.py` with a `make_pool_lifespan(name, dsn, *, min_size, max_size)` factory. Cite: `services/mcp_tools/mcp_eln_local/main.py:101–184`, `services/mcp_tools/mcp_logs_sciy/backends/fake_postgres.py:110-127`.

2. **The `cap_jsonb(...)` use at L502 and L566** is fine — `payload_caps.py` is already in `common`. Cited as proof the shared layer works.

3. **`_validate_id` + the three regex constants `_ID_RE`/`_PROJECT_CODE_RE`/`_FAMILY_RE`** at L199–210 are a homegrown ID validator. The shared `services/mcp_tools/common/limits.py` already exports `MAX_SMILES_LEN` etc.; adding `MAX_ID_LEN = 128` and an `is_safe_id(s)` helper covers this. Cite: `services/mcp_tools/mcp_eln_local/main.py:199-210`.

4. **The dev-sentinel-password fail-closed guard** at `_check_dsn_safety` L104–116 has a sibling pattern in `mcp_logs_sciy` (which depends on `DEV_FAKE_LOGS_READER_PASSWORD` from `common/dev_sentinels.py`). The pattern is right ("refuse to start if dev sentinel still in DSN unless `*_ALLOW_DEV_PASSWORD=true`") but is reimplemented per service. Could move to a `common/dsn_safety.py` helper with one signature: `assert_no_dev_sentinel_in_dsn(dsn, sentinel, opt_out_env_var) -> None`.

5. **`_row_to_X` mapping helpers (L487–584)** — six near-duplicates of the same `dict[str, Any] -> Pydantic` conversion. Pydantic v2's `BaseModel.model_validate(row)` would do most of these directly; the only reason they exist is to:
   - Inject `citation_uri=...` and `valid_until=_valid_until_now()` (server-side decoration).
   - Coerce `str(row[X])` for UUID columns (Pydantic accepts UUID natively from psycopg's UUID type — these `str()` casts are likely defensive against `dict_row` returning UUIDs).
   - Filter rows where some keys are absent.

   After splitting into `models.py`, these become `ElnEntry.from_row(row)` classmethods that call `model_validate`.

### `# type: ignore` / `Any` / type-safety

- `# type: ignore` count in this file: **zero**. Cited audit-of-audits: only `tests/test_mcp_eln_local.py:98` carries one (`app_module._acquire = _fake_acquire  # type: ignore[assignment]`), which is acceptable for monkeypatch in tests.
- `Any` count: 11 (line numbers above in the cohesion table). Two are unavoidable (JSON `metadata`/`fields_jsonb` columns, L256, L294); the other nine all sit on `dict[str, Any]` row-mapper inputs (L487, L517, L535, L547, L557, L570) and SQL `params` dicts (L629, L755). After the split, the row mappers become `Self.from_row(row: psycopg.rows.DictRow)` and the params can become `psycopg.sql.Params` (a `Mapping[str, Any]` subtype). Modest improvement.
- Untyped functions: zero. Every `def` has annotations.
- Hidden untyped boundary: `dict_row` at L127 returns `dict[str, Any]` from psycopg. This is the principled type — psycopg can't statically know the row shape — so leave as is.

### SQL injection / RLS risks

Every SQL site uses **named-parameter binding** (`%(name)s` + a `params: dict[str, Any]`):

| Site | Lines | Parameterised? | Notes |
|---|---|---|---|
| `experiments_query` | 617–662 | YES — every `WHERE` clause appended is followed by an entry into `params` keyed identically. | The SQL is built by **string concatenation of compile-time literals** (lines like `sql.append(" AND e.entry_shape = %(entry_shape)s")` at L641). No user input ever enters the SQL string. Safe. |
| `experiments_fetch` | 716–727 | YES | Single param `entry_id` bound. |
| `reactions_query` | 745–777 | YES | Same pattern as `experiments_query`. |
| `reactions_fetch` | 791–838 | YES | Two queries, both parameterised. |
| `samples_fetch` | 854–883 | YES | Two queries, both parameterised. |
| `attachments_metadata` / `samples_by_entry` / `_fetch_attachments` / `_fetch_audit_summary` | 677–705, 902–953 | YES | All parameterised. |

The `cursor` parameter is the **one place where user-supplied opaque text reaches SQL**. `_decode_cursor` at L591–601 splits on `|` and validates the second half with `_ID_RE.match(eid)` (L599). The first half goes through `_parse_iso` (L213–222), which calls `datetime.fromisoformat` and re-raises `ValueError` on bad input. Both halves reach SQL only as bound parameters (`%(cursor_ts)s`, `%(cursor_id)s` at L650–653). Safe, even against a malicious cursor.

**Type-cast notes:** every UUID column is parameterised as `%(name)s::uuid` (e.g. L635, L723, L798, L827, L859, L902, L933, L948). This means a malformed UUID raises a Postgres-level cast error inside the cursor, not a Python-level error. The route surfaces it via `psycopg.OperationalError` → 503 (`_acquire` at L179). **Mild concern:** the agent will see "service_unavailable" for what is actually invalid input. Recommendation: catch `psycopg.errors.InvalidTextRepresentation` separately and return 400. Severity: LOW.

**RLS:** none of these queries set `app.current_user_entra_id`. Verified earlier: `mock_eln.*` schema has no RLS — it relies on the read-only role having `SELECT`-only grants and no row-level policies. Cite: `db/init/30_mock_eln_schema.sql:65, 368-374`. The reader role is `chemclaw_mock_eln_reader` per `30_mock_eln_schema.sql:57-63`; the DSN at L74–78 connects with that role. Architecturally consistent with the design — the schema is mock data, isolated by role grants, not by row-level policies.

**Bearer-token auth surface:** `create_app(name="mcp-eln-local", ..., required_scope="mcp_eln:read")` at L186–193 (verified against `services/mcp_tools/common/scopes.py` for cross-language pact). Routes themselves do not re-check claims; they trust the middleware. Correct per the design (claims live on `request.state.mcp_claims` if a route ever needs them).

### Schema-coupling

Every column referenced in SQL was matched against `db/init/30_mock_eln_schema.sql`:

- `mock_eln.entries` columns referenced in SQL (L619–622, L716–719, L820–823): `id, notebook_id, project_id, reaction_id, schema_kind, title, author_email, signed_by, status, entry_shape, data_quality_tier, fields_jsonb, freetext, freetext_length_chars, created_at, modified_at, signed_at`. All present (verified `30_mock_eln_schema.sql:159-183`).
- `mock_eln.projects` columns referenced (L624, L750, L795): `id, code`. All present.
- `mock_eln.canonical_reactions_with_ofat` view columns (L747–749): `reaction_id, canonical_smiles_rxn, family, project_id, step_number, ofat_count, mean_yield, last_activity_at`. View defined at `30_mock_eln_schema.sql:341-361`. All present.
- `mock_eln.entry_attachments` (L678–679): `id, filename, mime_type, size_bytes, description, uri, created_at` and `entry_id`. All present.
- `mock_eln.audit_trail` (L696): `actor_email, action, field_path, occurred_at, reason` and `entry_id`. All present.
- `mock_eln.samples` (L856–857, L944–947): `id, entry_id, sample_code, compound_id, amount_mg, purity_pct, notes, created_at`. All present.
- `mock_eln.results` (L876–877): `id, method_id, metric, value_num, value_text, unit, measured_at, metadata`. All present.

No drift. Same recommendation as in the generator section — add an introspection test against `information_schema.columns` so a future schema rename is caught at PR time.

### Determinism

Three places where wall-clock leaks into responses:

- `_valid_until_now()` at L471–472 returns `datetime.now(timezone.utc) + timedelta(days=settings.valid_until_days)`. This is called from every row mapper (L511, L531, L582). Two HTTP requests one second apart will produce different `valid_until` payloads. **Acceptable** because the field is "this fact is valid until X", not part of the row identity, but the field SHOULD NOT be cached upstream as part of the response key. The post-tool source-cache hook in agent-claw stamps temporal provenance based on this; if the cache key included `valid_until`, every request would miss the cache. Verify caching strategy. (Out of scope for this audit.)
- `MAX(e.modified_at) AS last_activity_at` in the view (DDL only) is deterministic.
- No other time-based decisions.

---

## File 3 — `services/mcp_tools/mcp_doc_fetcher/main.py` (728 LOC)

### Cohesion analysis

| # | Concern | Line range | Helpers |
|---|---|---|---|
| 1 | Module preamble: docstring, imports, security policy | `1` – `54` | 0 |
| 2 | Configuration constants (schemes, byte caps, env-var allow/deny lists, `_BLOCKED_NETWORKS`) | `55` – `121` | constants only |
| 3 | SSRF helpers: `_is_under`, `_ip_is_blocked`, `_validate_network_host` | `123` – `171` | 3 helpers |
| 4 | `create_app(...)` | `174` – `182` | 0 |
| 5 | URI parsing + scheme dispatch: `_parse_and_validate_uri`, `_fetch_file`, `_fetch_https`, `_get_pdf_bytes` | `185` – `432` | 4 helpers |
| 6 | `/fetch` endpoint + Pydantic models | `324` – `383` | 1 endpoint |
| 7 | `/pdf_pages` endpoint + helpers | `387` – `537` | 1 endpoint, embedded fallback flow |
| 8 | `/byte_offset_to_page` endpoint + page-table builder + binary search | `540` – `714` | 1 endpoint, 2 helpers |
| 9 | Local dev `__main__` | `718` – `728` | 0 |

The file is more cohesive than the other two — every line is plausibly "doc fetching" — but it conflates **security policy**, **per-scheme transport**, and **PDF processing** in one module. The plan's three-way split is the right shape.

### Proposed split (concrete)

Plan: `main.py`, `fetchers.py`, `validators.py`. Refining:

#### `services/mcp_tools/mcp_doc_fetcher/validators.py` (new, ~110 LOC)
- Lines to extract: `55` – `171` (configuration constants + SSRF helpers).
- Public surface: `parse_and_validate_uri(uri) -> ParseResult`, `validate_network_host(host) -> None`, `ALLOWED_SCHEMES`, `WIRED_SCHEMES`, `HARD_MAX_BYTES`, `DEFAULT_MAX_BYTES`, `MAX_PDF_PAGES`, `MAX_PDF_PAGES_PER_REQUEST`, `FILE_ROOTS`.
- Private: `_is_under`, `_ip_is_blocked`, `_BLOCKED_NETWORKS`, `_ALLOW_HOSTS`, `_DENY_HOSTS`, `_FILE_ROOTS`, `_MAX_REDIRECTS`.
- Why: this is the single highest-stakes block in the file (CVE surface). Isolating it lets `tests/test_validators.py` exhaustively assert: every blocked CIDR rejects, every IPv6 special address rejects, allow-list bypasses private-IP block iff host explicitly allow-listed, etc. Today these tests live mixed with HTTP transport tests.

#### `services/mcp_tools/mcp_doc_fetcher/fetchers.py` (new, ~140 LOC)
- Lines to extract: `211` – `321` (`_fetch_file`, `_fetch_https`).
- Public surface: `fetch_file(parsed, max_bytes) -> tuple[bytes, str]`, `fetch_https(parsed, uri, max_bytes) -> tuple[bytes, str]`, `fetch_bytes_for_uri(uri, max_bytes) -> tuple[bytes, str]` (a thin dispatcher that hides the wired-scheme switch — fixes the "every endpoint repeats `if scheme not in _WIRED_SCHEMES: return JSONResponse(501)`" duplication).
- Wires through `validators.parse_and_validate_uri` and `validators.validate_network_host`.
- The `_get_pdf_bytes` helper at L421–432 collapses into `fetch_bytes_for_uri(uri, max_bytes=HARD_MAX_BYTES)`.

#### `services/mcp_tools/mcp_doc_fetcher/pdf.py` (new, ~150 LOC)
- Lines to extract: `387` – `714` minus the FastAPI route shells.
- Public surface: `render_pages_to_png(pdf_bytes, page_indices) -> list[PdfPageResult]` (with the pdf2image/pypdf-fallback logic unwound), `build_page_offset_table(pdf_bytes) -> list[int]`, `offset_to_page(byte_offset, page_starts) -> int`.
- Private: the binary-search inner loop (L654–663), the `dsc_page_re` regex (L609).

#### `services/mcp_tools/mcp_doc_fetcher/main.py` (kept, ~150 LOC)
- Imports + `create_app` + Pydantic request/response models + the three route handlers. Each handler is now ~20 lines (parse, dispatch, materialise).

After split:
- `main.py` ≤ 150 LOC.
- Largest file: `pdf.py` ≈ 150 LOC.
- `validators.py` becomes the security review focal point.

### Duplication across MCPs

1. **`_BLOCKED_NETWORKS` and `_validate_network_host`** at L111–171 are the **only SSRF-defense block in the whole repo**. No duplication today, but as more network-fetching MCPs come online (`mcp_logs_sciy` real backend, future SharePoint/S3 stubs), they MUST share this code rather than reimplement. **Recommendation:** when this file gets split, lift `validators.py` into `services/mcp_tools/common/network_safety.py`. PR-7 should explicitly call this out.

2. **The `if scheme not in _WIRED_SCHEMES: return JSONResponse(status_code=501, ...)` block** is duplicated three times: L356–366, L446–456, L679–689. After the split, one shared `assert_wired_scheme(scheme) -> None` helper raising `HTTPException(501)` consolidates this.

3. **Bearer-token / scope wiring** is just `required_scope="mcp_doc_fetcher:fetch"` at L181 — already idiomatic, no duplication concern.

4. **The `try / except ValueError: raise / except Exception as exc: raise ValueError(f"fetch failed: {exc}")` pattern** at L368–377 (fetch endpoint), L459–464 (pdf_pages), L691–696 (byte_offset_to_page) is repeated **three times verbatim**. One helper `_wrap_transport_errors(callable)` would dedupe.

### `# type: ignore` / `Any` / type-safety

| Line | Code | Reason | Fix |
|---|---|---|---|
| 490 | `from pdf2image import convert_from_bytes  # type: ignore[import-untyped]` | `pdf2image` lacks type stubs. | **Acceptable**; alternative is to publish a stubs-only `pdf2image-stubs` package or write a 5-line `.pyi`. Low value. |
| 491 | `import PIL.Image  # type: ignore[import-untyped]` | Pillow ships `py.typed` since 10.x — likely stale ignore. | **Remove** if `pillow` ≥ 10.0.0; check `requirements.txt`. |
| 619 | `xref = reader.xref  # type: ignore[attr-defined]` | Accesses pypdf private attr. | The comment at L617–619 explains: pypdf's public API doesn't expose byte positions. **Justified**, but should narrow to `# type: ignore[attr-defined]  # pypdf private API; bumped each major` and add a pypdf-version pin in `requirements.txt`. |
| 621 | `ref = page.indirect_reference  # type: ignore[attr-defined]` | Same private-API concern. | Same — annotate the pypdf version pin in the comment. |

`Any` count: zero in this file. Untyped functions: zero. **The PDF-fallback `reader` outer-scope reference at L524 is a latent NameError** (`reader` is bound only in the `try` block at L470–472; if pypdf raises non-`ImportError` between L472 and L484, control flows to the outer `except ImportError` at L517 where `reader` is unbound). Severity: LOW (pypdf failures other than `ImportError` are rare and the surrounding `try` re-raises `ValueError`). **Fix:** initialise `reader = None` before the inner `try` and guard the fallback path with `if reader is None: raise ValueError("pypdf unavailable")`.

### SQL injection / RLS risks

This service does **not** touch Postgres. No SQL surface. No RLS concern.

The closest analogue is the **`file://` jail** at L211–242. Verified:

- `path.resolve(strict=True)` at L229 follows symlinks, so `/data/secret -> /etc/shadow` is caught by the `_is_under` check at L232.
- `urllib.parse.unquote(parsed.netloc + parsed.path)` at L221 handles percent-encoded path traversal (`%2e%2e`).
- The default empty `_FILE_ROOTS` at L88–92 means **all `file://` reads refused on a fresh deploy** — fail-closed by default.
- The error message at L235–238 deliberately does **not** echo the resolved path (L233–234 comment) — small but real information-disclosure mitigation.

Network jail at `_validate_network_host` (L132–171):

- IPv4 + IPv6 RFC1918 / link-local / loopback / unique-local all blocked (L111–121).
- Cloud metadata (169.254.169.254) covered by the `169.254.0.0/16` net.
- Allow-list (`MCP_DOC_FETCHER_ALLOW_HOSTS`) **plus** deny-list checked at every redirect hop (L301).
- Manual redirect walking (L282 `follow_redirects=False`) re-validates at every hop — mitigates open-redirect → cloud-metadata pivots.
- One nuance: at L150–155, when the host is itself a literal IP, the function checks `_ip_is_blocked(host)` and **only refuses** when `not in_allowlist or not _ALLOW_HOSTS`. Reading carefully: `in_allowlist` is `(not _ALLOW_HOSTS) or (h in _ALLOW_HOSTS)`. The condition `not in_allowlist or not _ALLOW_HOSTS` simplifies to `not (h in _ALLOW_HOSTS) or not _ALLOW_HOSTS`. If `_ALLOW_HOSTS` is non-empty AND the literal-IP host IS in the allow-list, the refusal is skipped — i.e. an operator who explicitly puts `10.20.30.40` in `MCP_DOC_FETCHER_ALLOW_HOSTS` overrides the private-IP block. **This is intentional** per the docstring at L70–74 ("intranet ELN/LIMS adapters legitimately resolve to RFC1918"). Worth a unit test to make sure the inversion stays correct on edits.
- `socket.getaddrinfo` (L161) does **synchronous** DNS in an `async` route. With the FastAPI default thread pool this is OK, but a malicious host with intentionally-slow DNS could hold up a request. **Recommendation:** wrap in `asyncio.to_thread` or use `aiodns`. Severity: LOW.

### Schema-coupling

None. The service is stateless apart from the file-jail roots and host allow/deny env vars.

### Determinism

`_build_page_offset_table` at L576–644 has three layered fallbacks (DSC `%%Page` regex → pypdf xref crawl → uniform-distribution heuristic). The "uniform distribution" branch at L643–644 produces deterministic output for a given file size (`page_size = total_size // total_pages`). All three branches are pure functions of `pdf_bytes`. Deterministic.

The HTTPS `User-Agent` is hardcoded at L276 — deterministic. Redirect handling is bounded at `_MAX_REDIRECTS = 5` (L107), deterministic.

---

## Cross-cutting recommendations (apply during PR-7)

### Stand up `services/mcp_tools/common/chemistry.py`
Lift the `mol_from_smiles(smiles, *, max_len=MAX_SMILES_LEN) -> Chem.Mol` helper. Replace the six near-duplicate sites cited above. Drops ~30 LOC across the codebase, normalises the error message ("invalid SMILES: <repr>"), and gives one place to add a future "validate stoichiometry" / "reject metals" rule. `services/mock_eln/seed/generator.py` should depend on it via `chemistry.py` (the new seed-side module).

### Stand up `services/mcp_tools/common/network_safety.py`
Lift the SSRF block from `mcp_doc_fetcher/main.py:111–171` so the next network-fetching MCP doesn't reimplement it. Add a `validate_outbound_url(url)` higher-level entry point that callers use directly.

### Stand up `services/mcp_tools/common/db_pool.py`
Lift `_pool_holder` + `_lifespan` + `_acquire` + `_check_dsn_safety` from `mcp_eln_local/main.py:98–184` so `mcp_logs_sciy/backends/fake_postgres.py` can drop its per-call connection in favour of pooled access.

### Tighten the dev-sentinel guard
`mcp_eln_local/main.py:104-116` already imports `DEV_MOCK_ELN_READER_PASSWORD` from `common/dev_sentinels.py`. The same pattern should be hardened into a shared `assert_no_dev_sentinel_in_dsn(dsn, sentinel, opt_out_env_var)` so a future MCP that forgets this guard fails CI on a static check (`grep -r "DEV_*_READER_PASSWORD" services/mcp_tools/*/main.py | xargs assert_calls_safety_helper`).

### Fix the `pdf2image`-fallback `reader`-unbound bug
`mcp_doc_fetcher/main.py:524`. Initialise `reader = None` outside the inner `try` and guard the fallback path. Trivial.

### Add schema-introspection regression tests
For both `mock_eln/seed/generator.py:COLUMNS` and every inline SQL in `mcp_eln_local/main.py`. Catches future column renames at PR time, not at smoke-test time.

### Bound the f-string interpolation in `write_seed_sql`
`mock_eln/seed/generator.py:1076` builds `\copy ... FROM PROGRAM 'gunzip -c {rel}'`. Add a regex assertion on `rel` before formatting. Defensive only — current callers are trusted — but cheap.

### Strip dead `# type: ignore` for Pillow
`mcp_doc_fetcher/main.py:491`. Pillow ships `py.typed`. Verify via `requirements.txt` then drop the ignore.

---

## Summary table — concrete LOC reductions after PR-7

| Today | After PR-7 | Δ |
|---|---|---|
| `mock_eln/seed/generator.py` 1135 LOC | `generator.py` ~120 + `_helpers.py` ~120 + `chemistry.py` ~80 + `state.py` ~30 + `projects_methods.py` ~80 + `entries.py` ~250 + `derived.py` ~150 + `sql_emitter.py` ~80 = **~910 LOC** | -225 (after deduplicating the OFAT/Discovery shape branch via `_render_entry_for_shape`) |
| `mcp_eln_local/main.py` 969 LOC | `main.py` ~50 + `settings.py` ~40 + `db.py` ~80 + `models.py` ~270 + `queries.py` ~250 + `routes.py` ~280 = **~970 LOC** | ~0 (no dedup possible inside this file; gain is purely cohesion + testability + reuse with `mcp_logs_sciy` later) |
| `mcp_doc_fetcher/main.py` 728 LOC | `main.py` ~150 + `validators.py` ~110 + `fetchers.py` ~140 + `pdf.py` ~150 = **~550 LOC** | -178 (after `_wrap_transport_errors` helper + `assert_wired_scheme` helper) |
| **3 files, 2832 LOC** | **15 files, 2430 LOC** | **-402 LOC, no behaviour change** |

Largest single file post-split: `entries.py` ≈ 250 LOC. Every file is under the 300-LOC threshold the plan recommends, and every concern has its own test surface.

---

## Verification checklist for PR-7 (per the plan)

- [ ] `.venv/bin/pytest services/mcp_tools/mcp_eln_local/tests/ services/mock_eln/tests/ -q` clean.
- [ ] `./scripts/smoke.sh` green.
- [ ] Determinism regression: `WORLD_SEED=42 python -m services.mock_eln.seed.generator` produces fixtures whose SHA-256 matches the pre-split run. Lock the checksum in `services/mock_eln/tests/fixtures/golden_checksums.json`.
- [ ] `mypy --strict services/mcp_tools/mcp_eln_local services/mcp_tools/mcp_doc_fetcher services/mock_eln/seed` ≤ pre-split error count.
- [ ] `npm test --workspace services/agent-claw` covering the agent-side ELN builtins still 100 % green (model contract is a JSON wire format; route splitting can't change it but a Pydantic field rename would).

---

---

## Appendix A — Detailed evidence: OFAT vs Discovery duplication in `generate()`

The two emission loops at L577–697 (OFAT) and L700–822 (Discovery) are an instructive case study because the duplication is partial — they share the shape branch and the signing branch, but diverge on:

1. **Reaction binding.** OFAT entries are stamped with the **campaign's reaction** (L581 `rxn = ofat_campaigns_index[camp["id"]]["_reaction"]`). Discovery entries roll a 70 % chance of binding to a random project reaction (L723 `if rng.random() < 0.7 and rxns: rxn = rng.choice(rxns)`).
2. **Title formatting.** OFAT: `f"{camp['family']} OFAT — {camp['id']} #{i + 1:03d}"` (L611). Discovery (linked): `f"{family_name} discovery — {pcode} #{i + 1:04d}"` (L731). Discovery (analytical): `f"Analytical / QC entry — {pcode} #{i + 1:04d}"` (L738).
3. **Conditions source.** OFAT uses `pick_conditions(camp["family"], camp["sweep_axes"], i)` (L601) so the OFAT campaign's declared sweep axes drive variation. Discovery uses `pick_conditions(family_name, list(pools.keys())[:3], i)` (L726) — i.e. always sweep the first 3 pool axes. The "always first 3" choice is a low-grade smell (it makes the discovery generator order-sensitive to YAML key order in `condition_pools`); but it IS deterministic given a fixed YAML.
4. **`fields_jsonb` for `pure-freetext`.** OFAT preserves `{"campaign_id": camp["id"]}` (L641) so OFAT-aware aggregation works regardless of shape. Discovery sets `{}` (L769) — there's nothing structured to preserve.
5. **`fields_jsonb` `step_number`.** OFAT always reads `rxn["step_number"]` (L617). Discovery conditionally reads it: `rxn["step_number"] if rxn else None` (L746).
6. **Status probability.** OFAT signs at p=0.55 (L672), Discovery at p=0.50 (L797). The values are arbitrary but should be named constants — `_OFAT_SIGN_P = 0.55`, `_DISCOVERY_SIGN_P = 0.50`.
7. **Modified-at jitter.** OFAT modifies up to 48 h after creation (L694 `rng.randint(1, 48)`). Discovery up to 72 h (L819 `rng.randint(1, 72)`).
8. **Signed-at window.** OFAT 0–5 days (L673), Discovery 0–7 days (L798).

Items 1–3 are real semantic differences. Items 4–8 are arbitrary constants that are fine but should be named.

The entire structured/freetext/mixed branching (L634–670 vs L764–795) is **structurally identical** modulo the differences above. After lifting to a shared `_render_entry_for_shape(...)`, the OFAT loop and the Discovery loop each shrink to roughly:

```python
for i, (ts, chemist) in enumerate(ts_chemist):
    distrib = next_distribution(distributions, entry_index)
    entry_index += 1
    family_name, conditions, rxn_id, scale_mg, title = (...campaign-specific or discovery-specific...)
    yield_pct = compute_yield(family_name, conditions, distrib.quality, rng)
    fields_jsonb, freetext, ftext_len = _render_entry_for_shape(
        shape=distrib.shape,
        structured=build_structured(family_name, scale_mg, rxn, conditions, yield_pct, distrib.quality),
        conditions=conditions,
        ftext_fields=build_ftext_fields(...),
        ftext_band=distrib.ftext_band,
        ftext_quality=distrib.ftext_quality,
        quality=distrib.quality,
        rng=rng,
        extra_freetext_fields={"campaign_id": campaign_id} if campaign_id else None,
    )
    status, signed_at, signed_by = compute_signature(rng, ts, chemist, sign_p=_OFAT_SIGN_P)
    state.add("entries", _build_entry_row(...))
```

That collapses both loops to ~25 lines each plus one ~40-line shared helper — a ~80-LOC reduction.

---

## Appendix B — `experiments_query` SQL builder evidence (`mcp_eln_local/main.py`)

The SQL builder at L617–657 is the cleanest example of the inline-SQL pattern that PR-7 should hoist into `queries.py`. Annotated:

```python
sql = [
    """
    SELECT e.id, e.notebook_id, ..., e.signed_at,
           p.code AS project_code
    FROM mock_eln.entries e
    JOIN mock_eln.projects p ON p.id = e.project_id
    WHERE p.code = %(project_code)s
    """  # base — always present
]
params: dict[str, Any] = {"project_code": req.project_code}

# Six conditional WHERE-clause appends. Each is exactly the
# same shape: append a `f" AND col = %(name)s"` literal to sql[],
# set params[name] to the input value.
if req.schema_kind is not None: ...
if req.reaction_id is not None: ...     # uses ::uuid cast
if since_dt is not None: ...
if req.entry_shape is not None: ...
if req.data_quality_tier is not None: ...
if cursor_ts is not None and cursor_id is not None:
    # Keyset cursor — special-cased ordering tuple
    sql.append(" AND (e.modified_at, e.id::text) < (%(cursor_ts)s, %(cursor_id)s)")
    params["cursor_ts"] = cursor_ts
    params["cursor_id"] = cursor_id

sql.append(" ORDER BY e.modified_at DESC, e.id DESC LIMIT %(limit_plus)s")
params["limit_plus"] = req.limit + 1
```

Refactor proposal in `queries.py`:

```python
def build_experiments_query(req: ExperimentsQueryIn,
                            cursor_ts: datetime | None,
                            cursor_id: str | None,
                            since_dt: datetime | None) -> tuple[str, dict[str, Any]]:
    clauses: list[tuple[str, str, Any, str | None]] = [
        # (column expr, sql fragment, value, type-cast)
        ("p.code = %(project_code)s",            req.project_code,         None),
        ("e.schema_kind = %(schema_kind)s",      req.schema_kind,          None),
        ("e.reaction_id = %(reaction_id)s::uuid", req.reaction_id,         "uuid"),
        ("e.modified_at >= %(since)s",           since_dt,                 None),
        ("e.entry_shape = %(entry_shape)s",      req.entry_shape,          None),
        ("e.data_quality_tier = %(data_quality_tier)s", req.data_quality_tier, None),
    ]
    sql_parts = [_EXPERIMENTS_BASE_SELECT]
    params: dict[str, Any] = {}
    for clause, value, _cast in clauses:
        if value is not None:
            sql_parts.append(f" AND {clause}")
            params[clause.split("=")[0].split(".")[-1].strip()] = value
    if cursor_ts is not None and cursor_id is not None:
        sql_parts.append(_KEYSET_CURSOR_CLAUSE)
        params["cursor_ts"] = cursor_ts
        params["cursor_id"] = cursor_id
    sql_parts.append(_EXPERIMENTS_TAIL)
    params["limit_plus"] = req.limit + 1
    return "".join(sql_parts), params
```

(The above is illustrative — actual implementation would prefer named-clause helpers over string parsing.)

The same pattern recurs in `reactions_query` at L745–772. After extraction, both functions live in `queries.py` and share a `_combine_clauses(...)` helper.

---

## Appendix C — Doc-fetcher edge cases worth a regression test

Concrete edge cases the security model claims to cover but which lack explicit assertions in `services/mcp_tools/mcp_doc_fetcher/tests/` (verify when extracting `validators.py`):

1. **IPv4-mapped IPv6 addresses** — `::ffff:10.0.0.1` is a valid IPv6 address that semantically represents `10.0.0.1`. `_BLOCKED_NETWORKS` includes `10.0.0.0/8` (IPv4) but Python's `ipaddress.ip_address("::ffff:10.0.0.1")` returns an `IPv6Address`. Verify the check at L129 catches this. (Quick test: `ipaddress.IPv4Address('10.0.0.1') in ipaddress.ip_network('10.0.0.0/8')` is True; `ipaddress.IPv6Address('::ffff:10.0.0.1') in ipaddress.ip_network('10.0.0.0/8')` is **False**. **Likely bug.**) **Recommendation:** in `_ip_is_blocked`, normalise IPv4-mapped IPv6 to IPv4 before comparison: `if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped: addr = addr.ipv4_mapped`.

2. **IDN (Punycode) hosts** — A request to `xn--exmple-cua.com` (a homograph of an allow-listed `example.com`) MUST be checked in its **canonical** form. The current code lowercases the host (L140) but does not call `host.encode('idna').decode()` first. Likely fine for an English-language ops team, but documenting the assumption in `validators.py` is cheap.

3. **DNS rebinding** — Between the `_validate_network_host` call and the actual `httpx` connect, DNS could change. Mitigations are non-trivial (resolve once, dial that IP). Out of scope for PR-7 but worth a future Phase tracking issue.

4. **Symlink TOCTOU** — `_fetch_file` resolves the path with `strict=True` (L229), checks containment, then reads. Between `resolve` and `read_bytes` (L249) a symlink could be swapped. Mitigation: `os.open(O_NOFOLLOW)` + `os.read`. Severity: LOW (attacker would need write access to the file root, in which case they already have what they want).

5. **`_FILE_ROOTS` parsing on Windows** — L88 splits on `:` which collides with drive letters (`C:\data:D:\more`). Currently moot (Linux containers only) but should be documented.

---

## Appendix D — `# type: ignore` audit across the MCP fleet

Snapshot of every `# type: ignore` in `services/mcp_tools/` for cross-reference (collected via `grep -rn 'type:.*ignore'`):

| File | Line | Reason | Fix priority |
|---|---|---|---|
| `mcp_doc_fetcher/main.py` | 490 | `pdf2image` no stubs | LOW — vendor lib |
| `mcp_doc_fetcher/main.py` | 491 | `PIL.Image` — Pillow ≥ 10 ships `py.typed` | **MEDIUM — likely stale** |
| `mcp_doc_fetcher/main.py` | 619 | pypdf `xref` private attr | LOW — justified, document version pin |
| `mcp_doc_fetcher/main.py` | 621 | pypdf `indirect_reference` private attr | LOW — same |
| `mcp_logs_sciy/main.py` | 272 | `_lifespan(_app: FastAPI)` declared without return | **MEDIUM — should be `-> AsyncIterator[None]`** |
| `mcp_tabicl/pca.py` | 15 | sklearn no stubs | LOW |
| `mcp_tabicl/inference.py` | 18-21 | tabicl optional dep, dynamic shadow | LOW |
| `mcp_tabicl/featurizer.py` | 82, 93, 109 | drfp dynamic import, fallback shim | LOW |
| `mcp_chemprop/main.py` | 58-60 | chemprop optional, torch no stubs | LOW |
| `mcp_xtb/main.py` | 56-57 | rdkit no stubs (optional dep) | LOW — but `services/mcp_tools/common/chemistry.py` lift would centralise it |
| `mcp_aizynth/main.py` | 51 | aizynthfinder no stubs | LOW |
| `mcp_askcos/main.py` | 53 | askcos2 no stubs | LOW |
| `common/app.py` | 130 | `lifespan(app)` lifespan-of-lifespans | LOW — generic-protocol limitation |
| `mcp_eln_local/tests/test_mcp_eln_local.py` | 98 | monkey-patch `_acquire` | LOW — test only |

**Total:** 17 `# type: ignore` lines across `services/mcp_tools/`. The fleet is in a healthy state. The two MEDIUM items above (lines `mcp_doc_fetcher/main.py:491` and `mcp_logs_sciy/main.py:272`) are easy wins for PR-7's "remove every ignore where possible" requirement (per the plan's bulleted list of ignores at lines `70` of `develop-an-intense-code-happy-feather.md`).

---

## Appendix E — Schema-coupling quick reference (mcp_eln_local)

For the future `queries.py` module to remain in sync with `30_mock_eln_schema.sql`, document the dependency surface here so reviewers can spot drift in PRs:

| Query function (proposed) | Tables read | Columns referenced | DDL location |
|---|---|---|---|
| `build_experiments_query` | `mock_eln.entries`, `mock_eln.projects` | entries.{id, notebook_id, project_id, reaction_id, schema_kind, title, author_email, signed_by, status, entry_shape, data_quality_tier, fields_jsonb, freetext, freetext_length_chars, created_at, modified_at, signed_at}; projects.{id, code} | `30_mock_eln_schema.sql:159–183, 70–81` |
| `EXPERIMENTS_FETCH_SQL` | same + filter on `entries.id` | same | same |
| `OFAT_CHILDREN_SQL` | same + filter on `entries.reaction_id` + JSON path `fields_jsonb -> 'results' -> 'yield_pct'` | same | same |
| `build_reactions_query` | `mock_eln.canonical_reactions_with_ofat` (view), `mock_eln.projects` | view.{reaction_id, canonical_smiles_rxn, family, project_id, step_number, ofat_count, mean_yield, last_activity_at}; projects.{id, code} | `30_mock_eln_schema.sql:341–361, 70–81` |
| `REACTIONS_FETCH_SQL` | same + filter on view.reaction_id | same | same |
| `ATTACHMENTS_BY_ENTRY_SQL` | `mock_eln.entry_attachments` | {id, filename, mime_type, size_bytes, description, uri, created_at, entry_id} | `30_mock_eln_schema.sql:215–224` |
| `AUDIT_SUMMARY_SQL` | `mock_eln.audit_trail` | {actor_email, action, field_path, occurred_at, reason, entry_id} | `30_mock_eln_schema.sql:311–321` |
| `SAMPLE_BY_ID_SQL` | `mock_eln.samples` | {id, entry_id, sample_code, compound_id, amount_mg, purity_pct, notes, created_at} | `30_mock_eln_schema.sql:245–262` |
| `RESULTS_BY_SAMPLE_SQL` | `mock_eln.results` | {id, method_id, metric, value_num, value_text, unit, measured_at, metadata, sample_id} | `30_mock_eln_schema.sql:290–301` |
| `SAMPLES_BY_ENTRY_SQL` | `mock_eln.samples` | same as SAMPLE_BY_ID_SQL | same |
| `ENTRY_EXISTS_SQL` | `mock_eln.entries` | id only | same |

The introspection-test recommendation translates to: for each row in this table, run `SELECT 1 FROM information_schema.columns WHERE table_schema='mock_eln' AND table_name=$1 AND column_name = ANY($2)` and assert the count matches `len(columns)`. Run on a hermetic Postgres testcontainer.

---

## File paths cited in this audit

- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mock_eln/seed/generator.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mock_eln/seed/freetext_templates.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mock_eln/seed/fake_logs_generator.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mock_eln/seed/world.yaml`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/mcp_eln_local/main.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/mcp_doc_fetcher/main.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/common/app.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/common/limits.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/common/dev_sentinels.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/common/payload_caps.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/mcp_xtb/main.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/mcp_rdkit/main.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/mcp_aizynth/main.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/mcp_askcos/main.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/mcp_chemprop/main.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/mcp_logs_sciy/main.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/services/mcp_tools/mcp_logs_sciy/backends/fake_postgres.py`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/db/init/30_mock_eln_schema.sql`
- `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/db/init/12_security_hardening.sql`
- `/Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md` (PR-7)
