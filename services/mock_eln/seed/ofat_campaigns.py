"""OFAT (One-Factor-At-a-Time) campaign emission for the mock ELN seed.

Each campaign in ``world.yaml`` produces one canonical reaction (re-using
an existing project-level reaction with the matching family if possible,
else minting a fresh one) plus N campaign-child entries that share that
reaction_id and vary along the campaign's declared sweep axes.

Determinism: the RNG-call sequence is preserved exactly so the seed
remains byte-identical against the canonical world.

Split from generator.py during PR-7 (Python God-file split).
"""

from __future__ import annotations

import random
from datetime import timedelta
from typing import Any

from .chemistry_families import build_reaction_smiles
from .entry_shapes import pick_conditions, render_entry_for_shape, sample_yield


def setup_ofat_reactions(
    state,
    world: dict[str, Any],
    project_reactions: dict[str, list[dict[str, Any]]],
    families: dict[str, dict[str, Any]],
    stable_uuid,
    iso,
    parse_iso,
    jstr,
    rng: random.Random,
) -> dict[str, dict[str, Any]]:
    """Pick or create a canonical reaction per OFAT campaign.

    For each campaign, find an existing project reaction whose family
    matches; otherwise mint a new reaction tagged ``source: ofat_campaign``.
    Returns a map of ``campaign_id`` → ``{**campaign, "_reaction": rxn}``.
    """
    ofat_campaigns_index: dict[str, dict[str, Any]] = {}
    for camp in world["ofat_campaigns"]:
        proj_code = camp["project_code"]
        family_name = camp["family"]
        candidate = None
        for r in project_reactions[proj_code]:
            if r["family"] == family_name:
                candidate = r
                break
        if candidate is None:
            fam = families[family_name]
            rxn_smi, _, _ = build_reaction_smiles(fam, rng)
            rid = stable_uuid("reaction-ofat", camp["id"])
            pid = stable_uuid("project", proj_code)
            candidate = {
                "id": rid,
                "canonical_smiles_rxn": rxn_smi,
                "family": family_name,
                "step_number": 1,
                "project_id": pid,
                "metadata": jstr({"source": "ofat_campaign", "campaign": camp["id"]}),
                "created_at": iso(
                    parse_iso(
                        next(p for p in world["projects"] if p["code"] == proj_code)[
                            "started_at"
                        ]
                    )
                ),
            }
            state.add("reactions", candidate)
            project_reactions[proj_code].append(candidate)
        ofat_campaigns_index[camp["id"]] = {**camp, "_reaction": candidate}
    return ofat_campaigns_index


def emit_ofat_entries(
    state,
    world: dict[str, Any],
    ofat_campaigns_index: dict[str, dict[str, Any]],
    project_notebooks: dict[str, list[dict[str, Any]]],
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
    """Emit OFAT campaign-child entries (one per campaign × entry_count).

    Returns the post-emission entry_index so the orchestrator's running
    counter advances correctly into the Discovery phase. The RNG sequence
    matches the original inline loop exactly.
    """
    entry_index = entry_index_start
    for camp in world["ofat_campaigns"]:
        proj_code = camp["project_code"]
        proj = next(p for p in world["projects"] if p["code"] == proj_code)
        pid = stable_uuid("project", proj_code)
        rxn = ofat_campaigns_index[camp["id"]]["_reaction"]
        chemists = proj["chemists"]
        nbs = [
            n
            for n in project_notebooks[proj_code]
            if n["kind"] in ("process-dev", "discovery")
        ]
        if not nbs:
            nbs = project_notebooks[proj_code]
        ts_chemist = burst_dates(
            parse_iso(proj["started_at"]),
            parse_iso(proj["ended_at"]),
            camp["entry_count"],
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

            conditions = pick_conditions(
                camp["family"], camp["sweep_axes"], i, pools
            )
            yield_pct = sample_yield(camp["family"], conditions, families, bonuses, rng)
            if quality == "failed":
                yield_pct = 0.0
            elif quality == "noisy":
                yield_pct = round(max(0.0, yield_pct + rng.gauss(0, 5)), 2)

            scale_mg = rng.choice([50, 100, 200, 500, 1000, 2000])
            entry_id = stable_uuid("entry-ofat", camp["id"], i)
            nb = nbs[i % len(nbs)]
            title = f"{camp['family']} OFAT — {camp['id']} #{i + 1:03d}"

            structured = {
                "family": camp["family"],
                "step_number": rxn["step_number"],
                "scale_mg": scale_mg,
                "campaign_id": camp["id"],
                "conditions": conditions,
                "results": {
                    "yield_pct": yield_pct,
                    "outcome_status": "completed" if quality != "failed" else "failed",
                },
            }
            ftext_fields = {
                **{
                    k: v
                    for k, v in conditions.items()
                    if k
                    in (
                        "solvent",
                        "base",
                        "ligand",
                        "temperature_c",
                        "time_h",
                        "catalyst",
                        "reductant",
                        "acid",
                        "coupling_reagent",
                    )
                },
                "yield_pct": yield_pct,
                "scale_mg": scale_mg,
                "family": camp["family"],
                "outcome": "completed" if quality != "failed" else "failed",
            }

            # ~0.5% of entries with freetext carry an adversarial probe
            # (prompt-injection bait, fact-id fabrication, etc.) so the
            # agent's safety hooks have continuous regression coverage.
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
                pure_freetext_fields_jsonb={"campaign_id": camp["id"]},
                noisy_raw_remarks="see freetext for actuals",
                guard_partial_when_empty_keys=False,
            )

            status = (
                "signed"
                if rng.random() < 0.55
                else rng.choice(["draft", "in_progress", "witnessed", "archived"])
            )
            signed_at = (
                iso(ts + timedelta(days=rng.randint(0, 5)))
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
                    "reaction_id": rxn["id"],
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
                    "modified_at": iso(ts + timedelta(hours=rng.randint(1, 48))),
                    "signed_at": signed_at,
                },
            )

    return entry_index
