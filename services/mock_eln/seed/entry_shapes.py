"""Entry-shape rendering + Discovery-entry emission.

The entries-rendering block in the mock-ELN generator was duplicated
across the OFAT and Discovery loops (~80 LOC of structured / pure-
freetext / mixed branching with three subtle differences). This module
consolidates the duplication into ``render_entry_for_shape`` and houses
the Discovery-loop driver + the closures (``sample_yield``,
``pick_conditions``) that are shared between OFAT and Discovery.

Determinism: the RNG-call ordering is preserved exactly — the helper
calls ``rng.sample`` and ``ft.render_freetext`` in the same order as
the original inline code, so re-running with a fixed seed produces the
same byte stream as before the split.

Split from generator.py during PR-7 (Python God-file split).
"""

from __future__ import annotations

import random
from datetime import timedelta
from typing import Any

from services.mock_eln.seed import freetext_templates as ft


# --------------------------------------------------------------------------
# Closures lifted to module level
# --------------------------------------------------------------------------
def sample_yield(
    family_name: str,
    conditions: dict[str, Any],
    families: dict[str, dict[str, Any]],
    bonuses: dict[str, dict[str, dict[str, float]]],
    rng: random.Random,
) -> float | None:
    """Noisy regression: base + sum(condition bonuses) + N(0, sigma)."""
    fam = families[family_name]
    base = float(fam["base_yield_pct"])
    sigma = float(fam["yield_sigma"])
    bonus = 0.0
    for axis, value in conditions.items():
        axis_bonus = bonuses.get(family_name, {}).get(axis, {})
        if isinstance(axis_bonus, dict):
            bonus += float(
                axis_bonus.get(str(value), axis_bonus.get(value, 0.0)) or 0.0
            )
    y = base + bonus + rng.gauss(0, sigma)
    return max(0.0, min(99.5, round(y, 2)))


def pick_conditions(
    family_name: str,
    sweep_axes: list[str],
    idx: int,
    pools: dict[str, list[Any]],
) -> dict[str, Any]:
    """Pick a condition tuple. Sweep axes are varied; non-swept ones are
    held at a sensible default."""
    out: dict[str, Any] = {}
    # All axes get a value (so freetext template has it). Sweep axes are
    # cycled via idx so each campaign exhibits visible variation.
    for axis, vals in pools.items():
        if axis in sweep_axes:
            out[axis] = vals[idx % len(vals)]
        else:
            out[axis] = vals[0]
    return out


# --------------------------------------------------------------------------
# Shape rendering — the previously-duplicated 80-LOC branch
# --------------------------------------------------------------------------
def _band_for(ftext_band: str) -> tuple[int, int]:
    """Look up the (lo, hi) char-length range for a freetext band name.
    Replaces four copies of the inline scan.

    Indexing semantics preserved from the original inline expression
    ``ft.LENGTH_BANDS[[b[0] for b in ft.LENGTH_BANDS].index(ftext_band)][1:]``.
    """
    band_names = [b[0] for b in ft.LENGTH_BANDS]
    lo, hi = ft.LENGTH_BANDS[band_names.index(ftext_band)][1:]
    return lo, hi


def render_entry_for_shape(
    *,
    shape: str,
    structured: dict[str, Any],
    conditions: dict[str, Any],
    ftext_fields: dict[str, Any],
    ftext_band: str,
    ftext_quality: str,
    quality: str,
    rng: random.Random,
    adversarial: bool,
    pure_freetext_fields_jsonb: dict[str, Any],
    noisy_raw_remarks: str,
    guard_partial_when_empty_keys: bool,
) -> tuple[dict[str, Any], str, int]:
    """Render an entry's ``(fields_jsonb, freetext, ftext_len)`` for the given
    ``shape``. RNG-call ordering is identical to the original inline code.

    Parameters that vary between the OFAT and Discovery emission loops:

    - ``pure_freetext_fields_jsonb`` — for the pure-freetext branch.
      OFAT supplies ``{"campaign_id": camp_id}``; Discovery supplies ``{}``.
    - ``noisy_raw_remarks`` — text used for the ``raw_remarks`` field on
      noisy mixed-shape entries. OFAT uses
      ``"see freetext for actuals"``; Discovery uses ``"see freetext"``.
    - ``guard_partial_when_empty_keys`` — when True (Discovery), skip the
      ``rng.sample`` call entirely if ``conditions`` has no keys (defensive
      branch from the original code). When False (OFAT), the original code
      did not include this guard — both modes produce byte-identical output
      against the seed world because ``pick_conditions`` always returns a
      non-empty dict, but the parameter is preserved so a future change to
      ``pick_conditions`` doesn't silently flip OFAT behaviour.
    """
    if shape == "pure-structured":
        return structured, "", 0

    if shape == "pure-freetext":
        # Mirror behaviour: OFAT carries ``campaign_id`` so OFAT-aware
        # aggregation works regardless of shape; Discovery passes ``{}``.
        fields_jsonb = dict(pure_freetext_fields_jsonb)
        lo, hi = _band_for(ftext_band)
        freetext = ft.render_freetext(
            rng,
            ftext_fields,
            lo,
            hi,
            ftext_quality,
            pure_freetext=True,
            adversarial=adversarial,
        )
        return fields_jsonb, freetext, len(freetext)

    # mixed
    fields_jsonb = dict(structured)
    if quality == "partial":
        cs = dict(conditions)
        keys = list(cs.keys())
        if not guard_partial_when_empty_keys or keys:
            drop_n = max(1, int(len(keys) * 0.3))
            for k in rng.sample(keys, k=drop_n):
                del cs[k]
            fields_jsonb["conditions"] = cs
    if quality == "noisy":
        fields_jsonb["raw_remarks"] = noisy_raw_remarks
    lo, hi = _band_for(ftext_band)
    # Mixed-shape freetext is biased shorter.
    lo = min(lo, 50)
    hi = min(hi, 500) if hi <= 1500 else hi
    freetext = ft.render_freetext(
        rng,
        ftext_fields,
        lo,
        hi,
        ftext_quality,
        pure_freetext=False,
        adversarial=adversarial,
    )
    return fields_jsonb, freetext, len(freetext)


# --------------------------------------------------------------------------
# Discovery-entry emission
# --------------------------------------------------------------------------
def emit_discovery_entries(
    state,
    world: dict[str, Any],
    project_notebooks: dict[str, list[dict[str, Any]]],
    project_reactions: dict[str, list[dict[str, Any]]],
    proj_discovery_count: dict[str, int],
    shape_assignments: list[str],
    quality_assignments: list[str],
    freetext_assignments: list[str],
    freetext_quality_assignments: list[str],
    entry_index_start: int,
    families: dict[str, dict[str, Any]],
    bonuses: dict[str, dict[str, dict[str, float]]],
    pools: dict[str, list[Any]],
    holidays: set[str],
    adversarial_rate: float,
    stable_uuid,
    iso,
    parse_iso,
    jstr,
    burst_dates,
    rng: random.Random,
) -> int:
    """Emit Discovery (non-OFAT) entries for every project.

    Returns the post-emission entry_index so the orchestrator's running
    counter advances correctly. The RNG sequence matches the original
    inline loop exactly.
    """
    entry_index = entry_index_start
    for proj in world["projects"]:
        pcode = proj["code"]
        pid = stable_uuid("project", pcode)
        chemists = proj["chemists"]
        rxns = project_reactions[pcode]
        nbs = project_notebooks[pcode]
        n = proj_discovery_count[pcode]
        ts_chemist = burst_dates(
            parse_iso(proj["started_at"]),
            parse_iso(proj["ended_at"]),
            n,
            chemists,
            holidays,
            rng,
        )
        for i, (ts, chemist) in enumerate(ts_chemist):
            shape = shape_assignments[entry_index]
            quality = quality_assignments[entry_index]
            ftext_band = freetext_assignments[entry_index]
            ftext_quality = freetext_quality_assignments[entry_index]
            entry_index += 1

            # 70% are linked to a reaction; 30% are pure-discovery (analytical/qc style)
            if rng.random() < 0.7 and rxns:
                rxn = rng.choice(rxns)
                family_name = rxn["family"]
                conditions = pick_conditions(
                    family_name, list(pools.keys())[:3], i, pools
                )
                yield_pct = sample_yield(family_name, conditions, families, bonuses, rng)
                if quality == "failed":
                    yield_pct = 0.0
                rxn_id = rxn["id"]
                title = f"{family_name} discovery — {pcode} #{i + 1:04d}"
            else:
                rxn = None
                family_name = "analytical"
                conditions = {"solvent": "MeCN", "method": "HPLC-A"}
                yield_pct = None
                rxn_id = None
                title = f"Analytical / QC entry — {pcode} #{i + 1:04d}"

            scale_mg = rng.choice([10, 25, 50, 100, 200, 500])
            entry_id = stable_uuid("entry-disc", pcode, i)
            nb = nbs[i % len(nbs)]

            structured = {
                "family": family_name,
                "step_number": rxn["step_number"] if rxn else None,
                "scale_mg": scale_mg,
                "conditions": conditions,
                "results": {
                    "yield_pct": yield_pct,
                    "outcome_status": "completed" if quality != "failed" else "failed",
                },
            }
            ftext_fields = {
                **{
                    k: conditions.get(k)
                    for k in ("solvent", "base", "temperature_c")
                    if k in conditions
                },
                "yield_pct": yield_pct,
                "scale_mg": scale_mg,
                "family": family_name,
                "outcome": "completed" if quality != "failed" else "failed",
            }

            adversarial = shape != "pure-structured" and rng.random() < adversarial_rate

            fields_jsonb, freetext, ftext_len = render_entry_for_shape(
                shape=shape,
                structured=structured,
                conditions=conditions,
                ftext_fields=ftext_fields,
                ftext_band=ftext_band,
                ftext_quality=ftext_quality,
                quality=quality,
                rng=rng,
                adversarial=adversarial,
                pure_freetext_fields_jsonb={},
                noisy_raw_remarks="see freetext",
                guard_partial_when_empty_keys=True,
            )

            status = (
                "signed"
                if rng.random() < 0.5
                else rng.choice(["draft", "in_progress", "witnessed", "archived"])
            )
            signed_at = (
                iso(ts + timedelta(days=rng.randint(0, 7)))
                if status in ("signed", "witnessed", "archived")
                else ""
            )
            signed_by = chemist if status in ("signed", "witnessed", "archived") else ""

            state.add(
                "entries",
                {
                    "id": entry_id,
                    "notebook_id": nb["id"],
                    "project_id": pid,
                    "reaction_id": rxn_id or "",
                    "schema_kind": "ord-v0.3",
                    "title": title,
                    "author_email": chemist,
                    "signed_by": signed_by,
                    "status": status,
                    "entry_shape": shape,
                    "data_quality_tier": quality,
                    "fields_jsonb": jstr(fields_jsonb),
                    "freetext": freetext,
                    "freetext_length_chars": ftext_len,
                    "created_at": iso(ts),
                    "modified_at": iso(ts + timedelta(hours=rng.randint(1, 72))),
                    "signed_at": signed_at,
                },
            )

    return entry_index


# --------------------------------------------------------------------------
# Derived data: samples / results / entry_attachments / audit_trail
# --------------------------------------------------------------------------
def emit_derived_data(
    state,
    world: dict[str, Any],
    project_compounds: dict[str, list[dict[str, Any]]],
    method_ids: list[str],
    seed: int,
    stable_uuid,
    jstr,
) -> None:
    """Emit samples, results, entry_attachments, and audit_trail rows.

    Each derived table uses its own ``random.Random(seed + N)`` sub-RNG so
    that adding a new table later won't shift earlier RNG draws. The
    sub-RNG offsets must match the original generator: 1 = samples,
    2 = results, 3 = attachments, 4 = audit_trail.
    """
    entries = state.rows["entries"]
    samples_target = 3000
    results_target = 5000
    attachments_target = 3500
    audit_target = 12000

    # Samples: ~1.5 per entry, but skewed so some entries have 0 and others have many.
    #
    # sample_code format: S-{PROJECT_CODE}-{NNNNN} (zero-padded sequential
    # per project). This is the cross-link key used by fake_logs.datasets
    # (~70% of which carry a sample_id matching one of these codes), so it
    # MUST stay deterministic and predictable from the project code +
    # ordinal alone — DO NOT mix entry-derived bytes into it.
    sample_rng = random.Random(seed + 1)
    samples_emitted = 0
    project_sample_counters: dict[str, int] = {}
    pid_to_code: dict[str, str] = {
        stable_uuid("project", p["code"]): p["code"] for p in world["projects"]
    }
    for e in entries:
        if samples_emitted >= samples_target:
            break
        roll = sample_rng.random()
        n_samples = (
            0 if roll < 0.10
            else 1 if roll < 0.55
            else 2 if roll < 0.85
            else sample_rng.randint(3, 5)
        )
        if e["data_quality_tier"] == "failed":
            n_samples = max(0, n_samples - 1)
        proj_code = pid_to_code[e["project_id"]]
        for s_idx in range(n_samples):
            if samples_emitted >= samples_target:
                break
            sample_id = stable_uuid("sample", e["id"], s_idx)
            project_compounds_for_proj = project_compounds[proj_code]
            cmpd = (
                sample_rng.choice(project_compounds_for_proj)
                if project_compounds_for_proj
                else None
            )
            ordinal = project_sample_counters.get(proj_code, 0) + 1
            project_sample_counters[proj_code] = ordinal
            sample_code = f"S-{proj_code}-{ordinal:05d}"
            amt = round(sample_rng.uniform(5, 500), 2)
            purity = round(sample_rng.uniform(70, 99.9), 2)
            state.add(
                "samples",
                {
                    "id": sample_id,
                    "entry_id": e["id"],
                    "sample_code": sample_code,
                    "compound_id": cmpd["id"] if cmpd else "",
                    "amount_mg": amt,
                    "purity_pct": purity,
                    "notes": "" if sample_rng.random() < 0.7 else "Stored at -20C under N2.",
                    "created_at": e["created_at"],
                },
            )
            samples_emitted += 1

    # Results: ~1.7 per sample (nudged so total clears the 4500 floor).
    result_rng = random.Random(seed + 2)
    samples = state.rows["samples"]
    results_emitted = 0
    for s in samples:
        if results_emitted >= results_target:
            break
        n_res = 1 if result_rng.random() < 0.40 else 2 if result_rng.random() < 0.80 else 3
        for r_idx in range(n_res):
            if results_emitted >= results_target:
                break
            method_id = result_rng.choice(method_ids)
            metric = result_rng.choice(["purity_pct", "yield_pct", "rt_min", "mz", "ee_pct"])
            value_num: float | None = None
            value_text: str | None = None
            unit: str | None = None
            if metric == "purity_pct":
                value_num = round(result_rng.uniform(80, 100), 2)
                unit = "%"
            elif metric == "yield_pct":
                value_num = round(result_rng.uniform(20, 99), 2)
                unit = "%"
            elif metric == "rt_min":
                value_num = round(result_rng.uniform(1.0, 12.0), 3)
                unit = "min"
            elif metric == "mz":
                value_num = round(result_rng.uniform(150, 800), 4)
                unit = "Da"
            else:
                value_num = round(result_rng.uniform(85, 99.9), 2)
                unit = "% ee"
            rid = stable_uuid("result", s["id"], r_idx)
            measured_at = s["created_at"]
            state.add(
                "results",
                {
                    "id": rid,
                    "sample_id": s["id"],
                    "method_id": method_id,
                    "metric": metric,
                    "value_num": value_num,
                    "value_text": value_text or "",
                    "unit": unit,
                    "measured_at": measured_at,
                    "metadata": jstr({"qc": True}),
                    "created_at": measured_at,
                },
            )
            results_emitted += 1

    # Attachments: ~1.75 per entry on average
    att_rng = random.Random(seed + 3)
    att_emitted = 0
    for e in entries:
        if att_emitted >= attachments_target:
            break
        n_att = 1 if att_rng.random() < 0.55 else 2 if att_rng.random() < 0.85 else att_rng.randint(3, 5)
        for a_idx in range(n_att):
            if att_emitted >= attachments_target:
                break
            ext = att_rng.choice([
                ("pdf", "application/pdf", 200_000),
                ("png", "image/png", 80_000),
                ("xlsx", "application/vnd.ms-excel", 40_000),
                ("zip", "application/zip", 1_500_000),
                ("txt", "text/plain", 4_000),
            ])
            aid = stable_uuid("attachment", e["id"], a_idx)
            state.add(
                "entry_attachments",
                {
                    "id": aid,
                    "entry_id": e["id"],
                    "filename": f"{e['id'][:8]}-{a_idx + 1}.{ext[0]}",
                    "mime_type": ext[1],
                    "size_bytes": ext[2] + att_rng.randint(0, 50_000),
                    "description": att_rng.choice([
                        "Raw HPLC trace",
                        "Procedure photo",
                        "Workup notes",
                        "TLC scan",
                        "NMR PDF",
                        "Excel data dump",
                    ]),
                    "uri": f"local-mock-eln://{e['id']}/{a_idx + 1}",
                    "created_at": e["created_at"],
                },
            )
            att_emitted += 1

    # Audit trail: ~6 events per entry
    audit_rng = random.Random(seed + 4)
    audit_emitted = 0
    for e in entries:
        if audit_emitted >= audit_target:
            break
        n_audit = audit_rng.randint(3, 9)
        for a_idx in range(n_audit):
            if audit_emitted >= audit_target:
                break
            action = audit_rng.choice(["create", "update", "sign", "witness", "comment", "attach", "amend"])
            field_path = audit_rng.choice([
                "fields_jsonb.conditions.solvent",
                "fields_jsonb.results.yield_pct",
                "fields_jsonb.scale_mg",
                "freetext",
                "status",
            ])
            occurred_at = e["created_at"]
            aid = stable_uuid("audit", e["id"], a_idx)
            state.add(
                "audit_trail",
                {
                    "id": aid,
                    "entry_id": e["id"],
                    "actor_email": e["author_email"],
                    "action": action,
                    "field_path": field_path,
                    "old_value": jstr(None),
                    "new_value": jstr({"_": "redacted"}),
                    "reason": audit_rng.choice(["", "transcription error", "instrument re-cal", "operator correction", ""]),
                    "occurred_at": occurred_at,
                },
            )
            audit_emitted += 1
