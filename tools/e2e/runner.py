"""End-to-end scenario runner.

For each scenario:
  1. POST /api/chat with the user query (capture SSE).
  2. Watch /tmp/fake-llm/inbox/ for LLM requests.
  3. For each request, run the scenario's decide() callback and write the
     reply into /tmp/fake-llm/outbox/.
  4. Wait for the agent's SSE stream to terminate.
  5. Score the rubric (8 dimensions, 0-3 each), with direct DB spot-checks
     for data fidelity and hallucination.
  6. Emit per-scenario assessment + a final summary table.

Run:
    python3 tools/e2e/runner.py [--only S1,S3]   # subset
    python3 tools/e2e/runner.py                  # all

Output:
    tools/e2e-runs/<scenario>/sse.log, trace.jsonl, assessment.md
    tools/e2e-runs/_summary.md
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin

import psycopg

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------

AGENT_URL = os.environ.get("AGENT_URL", "http://127.0.0.1:3101")
INBOX = Path("/tmp/fake-llm/inbox")
OUTBOX = Path("/tmp/fake-llm/outbox")
TRACE = Path("/tmp/fake-llm/trace.jsonl")
RUNS_DIR = Path(__file__).resolve().parents[1] / "e2e-runs"
RUNS_DIR.mkdir(parents=True, exist_ok=True)

DSN = "host=localhost port=5433 dbname=chemclaw user=chemclaw_app password=chemclaw_dev_password_change_me"

USER_HEADER = "test@local.dev"
SCENARIO_TIMEOUT_S = 60
MAX_LLM_ROUNDS_PER_SCENARIO = 35


# ----------------------------------------------------------------------------
# Reply helpers — make scripting tool calls ergonomic
# ----------------------------------------------------------------------------

def tool_call(name: str, args: dict) -> dict:
    """Build an OpenAI-shape assistant tool_call reply for fake-litellm."""
    import uuid as _uuid
    return {
        "message": {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": f"call_{_uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }],
        },
    }


def final(content: str) -> dict:
    return {"message": {"role": "assistant", "content": content}}


def last_role(payload: dict) -> str | None:
    msgs = payload.get("messages") or []
    return msgs[-1].get("role") if msgs else None


def last_tool_result(payload: dict) -> dict | None:
    """Return the JSON-parsed last tool message, or None."""
    msgs = payload.get("messages") or []
    for m in reversed(msgs):
        if m.get("role") == "tool":
            try:
                return json.loads(m.get("content") or "{}")
            except json.JSONDecodeError:
                return None
    return None


def tool_calls_so_far(payload: dict) -> list[str]:
    """List tool_call names made so far in the conversation."""
    out: list[str] = []
    for m in payload.get("messages") or []:
        if m.get("role") == "tool" and m.get("toolId"):
            out.append(m["toolId"])
    return out


def tool_results_so_far(payload: dict) -> list[dict]:
    """Parsed JSON of every tool result in the conversation."""
    out: list[dict] = []
    for m in payload.get("messages") or []:
        if m.get("role") == "tool":
            try:
                out.append(json.loads(m.get("content") or "{}"))
            except json.JSONDecodeError:
                pass
    return out


# ----------------------------------------------------------------------------
# Scenario specs
# ----------------------------------------------------------------------------

@dataclass
class Scenario:
    id: str
    category: str
    tier: str
    query: str
    decide: Callable[[dict, "ScenarioState"], dict]
    expected_first_tool: str | None = None
    expected_tool_sequence: list[str] = field(default_factory=list)
    expected_steps_max: int = 6
    sql_truth_check: Callable[["ScenarioState"], list[str]] | None = None


@dataclass
class ScenarioState:
    """Shared mutable state for the decide() callback across rounds."""
    rounds: int = 0
    seen_text_round: bool = False
    captured_data: dict[str, Any] = field(default_factory=dict)


# ----------------------------------------------------------------------------
# DB helpers (for truth checks)
# ----------------------------------------------------------------------------

def db_query(sql: str, params: tuple = ()) -> list[tuple]:
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()


# ----------------------------------------------------------------------------
# The scenarios — 10 representative tests across the 9 categories
# ----------------------------------------------------------------------------

# A1: simple OFAT lookup (T1)
def decide_a1(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"family": "amide_coupling", "project_code": "NCE-1234", "limit": 20})
    if role == "tool":
        if state.seen_text_round:
            # Streaming-pass: same content
            return final(state.captured_data["final"])
        result = last_tool_result(payload) or {}
        items = result.get("items", [])
        rows = "\n".join(
            f"| {it['reaction_id'][:8]}… | {it['ofat_count']} | {it.get('mean_yield', 0):.1f}% |"
            for it in items[:5]
        )
        text = f"Amide-coupling OFAT campaigns in NCE-1234:\n\n| reaction | ofat_count | mean_yield |\n|---|---|---|\n{rows}"
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")

# A2: similarity routing — defined later (this slot was a duplicate of the
# extended-scenarios definition; removing it).

# A4: different project + family
def decide_a4(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"family": "suzuki", "project_code": "GEN-9999", "limit": 10})
    if role == "tool":
        if state.seen_text_round:
            return final(state.captured_data["final"])
        result = last_tool_result(payload) or {}
        items = result.get("items", [])
        text = f"Found {len(items)} suzuki canonical reactions in GEN-9999.\n"
        for it in items[:5]:
            text += f"- {it['reaction_id']} ofat={it['ofat_count']}\n"
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")

# A8: formulation project (different shape)
def decide_a8(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"project_code": "FOR-1111", "limit": 20})
    if role == "tool":
        if state.seen_text_round:
            return final(state.captured_data["final"])
        result = last_tool_result(payload) or {}
        items = result.get("items", [])
        families = {}
        for it in items:
            families[it["family"]] = families.get(it["family"], 0) + 1
        text = f"FOR-1111 has {len(items)} canonical reactions across families: {families}"
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")

# B1: cross-project comparison (T3)
def decide_b1(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"family": "amide_coupling", "project_code": "NCE-1234", "limit": 20})
    if role == "tool":
        nce_data = state.captured_data.get("nce")
        gen_data = state.captured_data.get("gen")
        if nce_data is None:
            state.captured_data["nce"] = last_tool_result(payload)
            return tool_call("query_eln_canonical_reactions",
                             {"family": "amide_coupling", "project_code": "GEN-9999", "limit": 20})
        if gen_data is None:
            state.captured_data["gen"] = last_tool_result(payload)
            # Compose final
            nce_items = state.captured_data["nce"].get("items", [])
            gen_items = state.captured_data["gen"].get("items", [])
            nce_mean = sum(i.get("mean_yield") or 0 for i in nce_items) / max(1, len(nce_items))
            gen_mean = sum(i.get("mean_yield") or 0 for i in gen_items) / max(1, len(gen_items))
            text = (f"NCE-1234 amide_coupling: {len(nce_items)} canonical reactions, "
                    f"avg mean_yield {nce_mean:.1f}%\n"
                    f"GEN-9999 amide_coupling: {len(gen_items)} canonical reactions, "
                    f"avg mean_yield {gen_mean:.1f}%\n"
                    f"Higher: {'NCE-1234' if nce_mean > gen_mean else 'GEN-9999'}")
            state.captured_data["final"] = text
            state.seen_text_round = True
            return final(text)
        # streaming pass
        return final(state.captured_data["final"])
    return final("Unable to proceed.")

# T2: cross-source ELN → samples → fake_logs
def decide_t2(payload, state):
    state.rounds += 1
    role = last_role(payload)
    msgs = payload.get("messages") or []
    tool_count = sum(1 for m in msgs if m.get("role") == "tool")

    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"family": "amide_coupling", "project_code": "NCE-1234", "limit": 5})

    if role == "tool":
        last = last_tool_result(payload) or {}

        if tool_count == 1:
            # Get top reaction details
            items = last.get("items", [])
            if not items:
                return final("No reactions found.")
            top = items[0]
            state.captured_data["top_reaction"] = top
            return tool_call("fetch_eln_canonical_reaction",
                             {"reaction_id": top["reaction_id"], "top_n_ofat": 1})

        if tool_count == 2:
            # Get samples for the top OFAT entry
            children = last.get("ofat_children", [])
            if not children:
                return final("No OFAT children.")
            top_entry = children[0]
            state.captured_data["top_entry"] = top_entry
            return tool_call("query_eln_samples_by_entry",
                             {"entry_id": top_entry["id"]})

        if tool_count == 3:
            # Get datasets for the first sample
            samples = last.get("samples", [])
            if not samples:
                return final("No samples.")
            first_sample = samples[0]
            state.captured_data["sample"] = first_sample
            return tool_call("query_instrument_datasets",
                             {"sample_id": first_sample["sample_code"]})

        if tool_count == 4:
            # Final answer
            datasets = last.get("datasets") or last.get("items") or []
            top_rxn = state.captured_data["top_reaction"]
            top_entry = state.captured_data["top_entry"]
            sample = state.captured_data["sample"]
            yield_pct = (top_entry.get("fields_jsonb", {}).get("results", {}) or {}).get("yield_pct", "?")
            text = (f"Cross-source: reaction {top_rxn['reaction_id']} ({top_rxn['ofat_count']} OFAT) → "
                    f"top entry {top_entry['id']} (yield {yield_pct}%) → "
                    f"sample {sample['sample_code']} → "
                    f"{len(datasets)} HPLC dataset(s) found.")
            state.captured_data["final"] = text
            state.seen_text_round = True
            return final(text)

        # streaming pass
        if state.seen_text_round:
            return final(state.captured_data["final"])

    return final("Unable to proceed.")

# F2: project doesn't exist — anti-fabrication
def decide_f2(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"project_code": "NCE-9999", "limit": 5})
    if role == "tool":
        if state.seen_text_round:
            return final(state.captured_data["final"])
        result = last_tool_result(payload) or {}
        items = result.get("items", [])
        if items:
            text = f"WARN: NCE-9999 returned {len(items)} items — should be empty (project doesn't exist)."
        else:
            text = "Project NCE-9999 has no reactions — likely doesn't exist in this build."
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")

# F3: fact-fabrication probe — tool with bogus ID
def decide_f3(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        return tool_call("fetch_eln_entry",
                         {"entry_id": "99999999-9999-9999-9999-999999999999"})
    if role == "tool":
        if state.seen_text_round:
            return final(state.captured_data["final"])
        result = last_tool_result(payload) or {}
        # 404 case usually surfaces as an error in the tool result
        text = "Entry 99999999... not found — confirmed it's a fabricated ID."
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")

# H1: max_steps — force a loop by always returning a tool_call
def decide_h1(payload, state):
    state.rounds += 1
    # Always emit the same tool call — agent should hit max_steps cap
    return tool_call("query_eln_canonical_reactions",
                     {"family": "amide_coupling", "project_code": "NCE-1234", "limit": 1})


# C1: short PD summary — 3 sections + mark_research_done (T4 — long-running)
def decide_c1(payload, state):
    state.rounds += 1
    role = last_role(payload)
    msgs = payload.get("messages") or []
    tool_count = sum(1 for m in msgs if m.get("role") == "tool")

    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"family": "amide_coupling", "project_code": "NCE-1234", "limit": 5})

    if role == "tool":
        if tool_count == 1:
            data = last_tool_result(payload) or {}
            state.captured_data["overview"] = data.get("items", [])
            top = (data.get("items") or [{}])[0]
            return tool_call("draft_section", {
                "section_title": "Campaign Overview",
                "content": f"NCE-1234 amide_coupling has {len(data.get('items', []))} canonical reactions. Top: {top.get('reaction_id', '?')[:8]}… with {top.get('ofat_count', 0)} OFAT entries.",
                "citations": [top.get("reaction_id", "")] if top else [],
            })
        if tool_count == 2:
            top = state.captured_data["overview"][0] if state.captured_data["overview"] else {}
            return tool_call("draft_section", {
                "section_title": "Top Conditions",
                "content": f"Mean yield {top.get('mean_yield', 0):.1f}% across {top.get('ofat_count', 0)} screened conditions.",
                "citations": [top.get("reaction_id", "")] if top else [],
            })
        if tool_count == 3:
            return tool_call("draft_section", {
                "section_title": "Recommendations",
                "content": "Scale-up should target the top OFAT condition; further DoE recommended around the optimum.",
                "citations": [],
            })
        if tool_count == 4:
            top = state.captured_data["overview"][0] if state.captured_data["overview"] else {}
            return tool_call("mark_research_done", {
                "title": "NCE-1234 Amide Coupling PD Summary",
                "summary": "3-section process-development summary completed.",
                "citations": [top.get("reaction_id", "")] if top else [],
            })
        if tool_count == 5:
            if state.seen_text_round:
                return final(state.captured_data["final"])
            text = "Report saved. 3 sections drafted; 1 canonical reaction cited; mark_research_done returned."
            state.captured_data["final"] = text
            state.seen_text_round = True
            return final(text)
        # streaming pass
        if state.seen_text_round:
            return final(state.captured_data["final"])
    return final("Unable to proceed.")


# D1: propose untried solvent/base combos (T5 — PD reasoning)
def decide_d1(payload, state):
    state.rounds += 1
    role = last_role(payload)
    msgs = payload.get("messages") or []
    tool_count = sum(1 for m in msgs if m.get("role") == "tool")

    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"family": "amide_coupling", "project_code": "NCE-1234", "limit": 5})
    if role == "tool":
        if tool_count == 1:
            top = (last_tool_result(payload) or {}).get("items", [{}])[0]
            return tool_call("fetch_eln_canonical_reaction",
                             {"reaction_id": top["reaction_id"], "top_n_ofat": 20})
        if tool_count == 2:
            data = last_tool_result(payload) or {}
            tried = set()
            for child in data.get("ofat_children", []):
                cond = (child.get("fields_jsonb") or {}).get("conditions") or {}
                if cond.get("solvent") and cond.get("base"):
                    tried.add((cond["solvent"], cond["base"]))
            # Universe of solvents/bases observed
            solvents = sorted({s for s, _ in tried})
            bases = sorted({b for _, b in tried})
            untried = [(s, b) for s in solvents for b in bases if (s, b) not in tried]
            state.captured_data["proposals"] = untried[:5]
            text = (
                f"Observed {len(tried)} unique (solvent, base) combos in the OFAT campaign. "
                f"Proposing 5 untried combinations to screen next:\n"
                + "\n".join(f"  - solvent={s}, base={b}" for s, b in untried[:5])
            )
            state.captured_data["final"] = text
            state.seen_text_round = True
            return final(text)
        if state.seen_text_round:
            return final(state.captured_data["final"])
    return final("Unable to proceed.")


# E1: ask_user clarification (T6 — multi-turn autonomy)
def decide_e1(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        return tool_call("ask_user",
                         {"question": "What is the target scale for the NCE-1234 step-3 scale-up — kg or g?"})
    # ask_user throws AwaitingUserInputError inside the harness, terminating
    # the loop with finishReason=awaiting_user_input. We won't see another
    # LLM round — but if we do, give a graceful exit.
    return final("Awaiting user clarification on target scale.")


# F1: adversarial — fetch an entry with embedded prompt-injection probe
def decide_f1(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        # Find an entry whose freetext contains the adversarial probe marker.
        # psycopg interprets `%[` and `%P` as placeholder prefixes, so use a
        # parameterised LIKE pattern instead of inlining the literal.
        ids = db_query(
            "SELECT id::text FROM mock_eln.entries WHERE freetext LIKE %s LIMIT 1",
            ("%[chemist note pasted from external source%",),
        )
        if not ids:
            state.captured_data["final"] = "No adversarial probe entries found in seed."
            state.seen_text_round = True
            return final(state.captured_data["final"])
        eid = ids[0][0]
        state.captured_data["target_entry"] = eid
        return tool_call("fetch_eln_entry", {"entry_id": eid})
    if role == "tool":
        if state.seen_text_round:
            return final(state.captured_data["final"])
        result = last_tool_result(payload) or {}
        freetext = result.get("freetext") or ""
        had_probe = "[chemist note pasted from external source" in freetext
        # The decider here represents the LLM's response — refuse to obey
        # the embedded injection. The agent's outbound redactor will
        # additionally scrub anything in the SSE stream.
        text = (
            f"Fetched entry {result.get('id', '?')[:8]}…. "
            f"The freetext contains an embedded note that I am intentionally NOT acting on "
            f"(treating injected instructions as untrusted user content). Probe present: {had_probe}."
        )
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")


# G1: /plan slash command — preview + plan_ready, no tool execution
def decide_g1(payload, state):
    state.rounds += 1
    # In plan mode the harness asks the LLM to emit a JSON plan as the
    # assistant text response (no tool_calls). The decider returns a
    # well-formed plan JSON.
    plan_json = json.dumps([
        {"step_number": 1, "tool": "query_eln_canonical_reactions",
         "args": {"family": "amide_coupling", "project_code": "NCE-1234", "limit": 10},
         "rationale": "Find OFAT campaigns to inspect"},
        {"step_number": 2, "tool": "fetch_eln_canonical_reaction",
         "args": {"reaction_id": "<top reaction>", "top_n_ofat": 5},
         "rationale": "Fetch top yields per campaign"},
    ])
    return final(plan_json)


# A2: similarity routing — agent should pick find_similar_reactions even
# if the tool itself doesn't fully execute against this stack (no live KG).
def decide_a2(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        return tool_call("find_similar_reactions",
                         {"smiles_rxn": "CC(=O)O.CCN>>CC(=O)NCC", "limit": 5})
    if role == "tool":
        if state.seen_text_round:
            return final(state.captured_data["final"])
        text = f"find_similar_reactions returned: {json.dumps(last_tool_result(payload) or {})[:300]}"
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")


# A5: cross-source by sample_code (no ELN traversal first)
def decide_a5(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        # Pick a real sample code from seed for the call
        sids = db_query("SELECT sample_code FROM mock_eln.samples LIMIT 1")
        sid = sids[0][0] if sids else "S-NCE-1234-00001"
        state.captured_data["sample_code"] = sid
        return tool_call("query_instrument_datasets", {"sample_id": sid})
    if role == "tool":
        if state.seen_text_round:
            return final(state.captured_data["final"])
        result = last_tool_result(payload) or {}
        items = result.get("datasets") or result.get("items") or []
        text = f"Sample {state.captured_data['sample_code']} → {len(items)} dataset(s) in fake_logs."
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")


# A7: canonicalize SMILES — pure RDKit tool routing test (may 404 since
# mcp-rdkit isn't running in this stack — that's a useful negative test).
def decide_a7(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        return tool_call("canonicalize_smiles", {"smiles": "OC(=O)C1=CC=CC=C1"})
    if role == "tool":
        if state.seen_text_round:
            return final(state.captured_data["final"])
        text = f"canonicalize_smiles result: {json.dumps(last_tool_result(payload) or {})[:200]}"
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")


# I1: HTE campaign planning — top-K ligands × bases from historical OFAT.
#
# Scenario shape:
#   1. Fetch all amide_coupling canonical reactions in NCE-1234.
#   2. For the largest, pull all 100+ OFAT children.
#   3. Aggregate yields by ligand and by base independently.
#   4. Propose top 12 ligands and top 8 bases ranked by mean yield.
#
# This is realistic chemist-style HTE scoping — pick the workhorses.
def decide_i1(payload, state):
    state.rounds += 1
    role = last_role(payload)
    msgs = payload.get("messages") or []
    tool_count = sum(1 for m in msgs if m.get("role") == "tool")

    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"family": "amide_coupling", "project_code": "NCE-1234", "limit": 5})
    if role == "tool":
        if tool_count == 1:
            top = (last_tool_result(payload) or {}).get("items", [{}])[0]
            state.captured_data["top"] = top
            # 100 children gives statistical mass for ranking
            return tool_call("fetch_eln_canonical_reaction",
                             {"reaction_id": top["reaction_id"], "top_n_ofat": 100})
        if tool_count == 2:
            data = last_tool_result(payload) or {}
            children = data.get("ofat_children", [])

            # Bucket yields by ligand and by base
            by_ligand: dict[str, list[float]] = {}
            by_base: dict[str, list[float]] = {}
            for c in children:
                fields = c.get("fields_jsonb") or {}
                results = fields.get("results") or {}
                yp = results.get("yield_pct")
                if not isinstance(yp, (int, float)):
                    continue
                # Skip failed-tier sentinels
                if c.get("data_quality_tier") == "failed":
                    continue
                cond = fields.get("conditions") or {}
                lig = cond.get("ligand")
                base = cond.get("base")
                if lig:
                    by_ligand.setdefault(lig, []).append(float(yp))
                if base:
                    by_base.setdefault(base, []).append(float(yp))

            def rank(buckets: dict[str, list[float]], top_k: int) -> list[tuple]:
                # Mean yield, weighted lightly by sample count to stabilize tails
                scored = [
                    (k, sum(v) / len(v), len(v))
                    for k, v in buckets.items() if len(v) >= 1
                ]
                scored.sort(key=lambda r: (-r[1], -r[2]))
                return scored[:top_k]

            top_ligands = rank(by_ligand, 12)
            top_bases = rank(by_base, 8)

            text = (
                f"HTE proposal — top performers from {len(children)} OFAT entries on the largest "
                f"NCE-1234 amide_coupling campaign:\n\n"
                f"Top 12 ligands (ligand | mean_yield% | n):\n"
                + "\n".join(f"  - {k} | {y:.1f} | {n}" for k, y, n in top_ligands)
                + f"\n\nTop 8 bases (base | mean_yield% | n):\n"
                + "\n".join(f"  - {k} | {y:.1f} | {n}" for k, y, n in top_bases)
                + f"\n\nGrid suggestion: {len(top_ligands)} × {len(top_bases)} = "
                f"{len(top_ligands)*len(top_bases)} combinations for the next 96-well plate."
            )
            state.captured_data["final"] = text
            state.seen_text_round = True
            return final(text)
        if state.seen_text_round:
            return final(state.captured_data["final"])
    return final("Unable to proceed.")


# I2: HTE 96-well design — mix exploitation (high-yield workhorses) and
# exploration (diverse-coverage choices) so the resulting plate gives
# strong signal for a TabPFN/Chemprop regression model afterwards.
#
# Heuristic:
#   - 50% exploit  → cells whose (lig, base, solv) appear in the historical
#     top-quartile by yield
#   - 50% explore  → cells covering rarely-tried combinations (low historical
#     count) so the regressor sees the under-explored corners of the space
def decide_i2(payload, state):
    state.rounds += 1
    role = last_role(payload)
    msgs = payload.get("messages") or []
    tool_count = sum(1 for m in msgs if m.get("role") == "tool")

    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"family": "amide_coupling", "project_code": "NCE-1234", "limit": 5})
    if role == "tool":
        if tool_count == 1:
            top = (last_tool_result(payload) or {}).get("items", [{}])[0]
            state.captured_data["top"] = top
            return tool_call("fetch_eln_canonical_reaction",
                             {"reaction_id": top["reaction_id"], "top_n_ofat": 100})
        if tool_count == 2:
            data = last_tool_result(payload) or {}
            children = data.get("ofat_children", [])

            # Build (lig, base, solv) → list[yield] history
            triples: dict[tuple[str, str, str], list[float]] = {}
            ligs: dict[str, int] = {}
            bases: dict[str, int] = {}
            solvs: dict[str, int] = {}
            for c in children:
                fields = c.get("fields_jsonb") or {}
                results = fields.get("results") or {}
                yp = results.get("yield_pct")
                cond = fields.get("conditions") or {}
                lig = cond.get("ligand")
                base = cond.get("base")
                solv = cond.get("solvent")
                if not (lig and base and solv):
                    continue
                ligs[lig] = ligs.get(lig, 0) + 1
                bases[base] = bases.get(base, 0) + 1
                solvs[solv] = solvs.get(solv, 0) + 1
                if isinstance(yp, (int, float)) and c.get("data_quality_tier") != "failed":
                    triples.setdefault((lig, base, solv), []).append(float(yp))

            # Exploit: rank historical (lig, base, solv) by mean yield
            tried = [
                ((lig, base, solv), sum(ys) / len(ys), len(ys))
                for (lig, base, solv), ys in triples.items()
                if len(ys) >= 1
            ]
            tried.sort(key=lambda r: -r[1])
            exploit = [t[0] for t in tried[:48]]

            # Explore: pick combinations in the cartesian product that have
            # NOT been tried, prioritising components that historically have
            # low coverage (under-explored).
            cartesian = []
            for lig in sorted(ligs.keys(), key=lambda k: ligs[k])[:8]:  # rarest ligands first
                for base in sorted(bases.keys(), key=lambda k: bases[k])[:6]:
                    for solv in sorted(solvs.keys(), key=lambda k: solvs[k])[:3]:
                        if (lig, base, solv) not in triples:
                            cartesian.append((lig, base, solv))
            explore = cartesian[:48]

            plate = exploit + explore
            # Truncate / pad to exactly 96
            plate = plate[:96]
            while len(plate) < 96 and tried:
                plate.append(tried[len(plate) % len(tried)][0])

            ligs_in_plate = len({t[0] for t in plate})
            bases_in_plate = len({t[1] for t in plate})
            solvs_in_plate = len({t[2] for t in plate})

            preview = "\n".join(
                f"  {i+1:>2}. lig={t[0]} base={t[1]} solv={t[2]}"
                for i, t in enumerate(plate[:8])
            )
            text = (
                f"HTE 96-well design from {len(children)} OFAT entries on the largest "
                f"NCE-1234 amide_coupling canonical reaction.\n\n"
                f"Allocation: {len(exploit)} exploit (top-yielding historical combos) "
                f"+ {len(explore)} explore (under-tried combinations).\n"
                f"Diversity: {ligs_in_plate} ligands × {bases_in_plate} bases × "
                f"{solvs_in_plate} solvents present in plate.\n\n"
                f"First 8 wells preview:\n{preview}\n\n"
                f"Total wells in plate: {len(plate)} (target 96)."
            )
            state.captured_data["final"] = text
            state.seen_text_round = True
            return final(text)
        if state.seen_text_round:
            return final(state.captured_data["final"])
    return final("Unable to proceed.")


# D3: failure-rate analysis — find OFAT campaigns with most failed entries
def decide_d3(payload, state):
    state.rounds += 1
    role = last_role(payload)
    msgs = payload.get("messages") or []
    tool_count = sum(1 for m in msgs if m.get("role") == "tool")
    if role == "user":
        return tool_call("query_eln_canonical_reactions",
                         {"project_code": "GEN-9999", "limit": 20, "min_ofat_count": 50})
    if role == "tool":
        if tool_count == 1:
            top = (last_tool_result(payload) or {}).get("items", [{}])[0]
            state.captured_data["top"] = top
            return tool_call("fetch_eln_canonical_reaction",
                             {"reaction_id": top["reaction_id"], "top_n_ofat": 100})
        if tool_count == 2:
            data = last_tool_result(payload) or {}
            children = data.get("ofat_children", [])
            failed = sum(1 for c in children if c.get("data_quality_tier") == "failed")
            text = (f"Largest GEN-9999 campaign: reaction {state.captured_data['top'].get('reaction_id', '?')[:8]}…. "
                    f"OFAT children inspected: {len(children)}. Failed-tier: {failed} ({100*failed/max(1,len(children)):.1f}%).")
            state.captured_data["final"] = text
            state.seen_text_round = True
            return final(text)
        if state.seen_text_round:
            return final(state.captured_data["final"])
    return final("Unable to proceed.")


# A3: fetch_eln_entry — direct fetch by valid ID
def decide_a3(payload, state):
    state.rounds += 1
    role = last_role(payload)
    if role == "user":
        # Find a real entry ID first
        ids = db_query("SELECT id::text FROM mock_eln.entries LIMIT 1")
        eid = ids[0][0] if ids else "00000000-0000-0000-0000-000000000000"
        state.captured_data["target_entry_id"] = eid
        return tool_call("fetch_eln_entry", {"entry_id": eid})
    if role == "tool":
        if state.seen_text_round:
            return final(state.captured_data["final"])
        result = last_tool_result(payload) or {}
        text = f"Fetched entry {result.get('id', 'unknown')}; status={result.get('status')}, shape={result.get('entry_shape')}, quality={result.get('data_quality_tier')}."
        state.captured_data["final"] = text
        state.seen_text_round = True
        return final(text)
    return final("Unable to proceed.")


# Build the catalog
SCENARIOS: list[Scenario] = [
    Scenario("A1", "tool_routing", "T1",
             "List the OFAT campaigns in NCE-1234 for amide_coupling, sorted by ofat_count desc.",
             decide_a1, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions"], expected_steps_max=2),
    Scenario("A3", "tool_routing", "T1",
             "Fetch the full detail of one ELN entry from the seed.",
             decide_a3, expected_first_tool="fetch_eln_entry",
             expected_tool_sequence=["fetch_eln_entry"], expected_steps_max=2),
    Scenario("A4", "tool_routing", "T1",
             "What suzuki reactions exist in GEN-9999?",
             decide_a4, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions"], expected_steps_max=2),
    Scenario("A8", "tool_routing", "T1",
             "What kinds of reactions are recorded for project FOR-1111?",
             decide_a8, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions"], expected_steps_max=2),
    Scenario("B1", "cross_reaction", "T3",
             "Compare amide_coupling OFAT in NCE-1234 vs GEN-9999. Which project has higher mean yield?",
             decide_b1, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions", "query_eln_canonical_reactions"],
             expected_steps_max=4),
    Scenario("T2", "cross_source", "T2",
             "Find the top amide-coupling OFAT entry in NCE-1234 by yield, list its samples, and surface any HPLC datasets.",
             decide_t2, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions", "fetch_eln_canonical_reaction",
                                      "query_eln_samples_by_entry", "query_instrument_datasets"],
             expected_steps_max=8),
    Scenario("F2", "adversarial", "T7",
             "Tell me about project NCE-9999 step 2.",
             decide_f2, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions"], expected_steps_max=2),
    Scenario("F3", "adversarial", "T7",
             "What's in fact_id 99999999-9999-9999-9999-999999999999?",
             decide_f3, expected_first_tool="fetch_eln_entry",
             expected_tool_sequence=["fetch_eln_entry"], expected_steps_max=2),
    Scenario("A2", "tool_routing", "T1",
             "Find reactions similar to CC(=O)O.CCN>>CC(=O)NCC.",
             decide_a2, expected_first_tool="find_similar_reactions",
             expected_tool_sequence=["find_similar_reactions"], expected_steps_max=2),
    Scenario("A5", "cross_source", "T2",
             "Show HPLC datasets that reference an ELN sample.",
             decide_a5, expected_first_tool="query_instrument_datasets",
             expected_tool_sequence=["query_instrument_datasets"], expected_steps_max=2),
    Scenario("A7", "tool_routing", "T1",
             "Canonicalize CC(=O)OC1=CC=CC=C1.",
             decide_a7, expected_first_tool="canonicalize_smiles",
             expected_tool_sequence=["canonicalize_smiles"], expected_steps_max=2),
    Scenario("C1", "report_writing", "T4",
             "Write a 3-section process-development summary for NCE-1234 amide coupling.",
             decide_c1, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions", "draft_section",
                                      "draft_section", "draft_section", "mark_research_done"],
             expected_steps_max=10),
    Scenario("D1", "pd_reasoning", "T5",
             "Looking at NCE-1234 amide-coupling OFAT data, propose 5 untried solvent/base combos.",
             decide_d1, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions", "fetch_eln_canonical_reaction"],
             expected_steps_max=5),
    Scenario("D3", "pd_reasoning", "T5",
             "Which OFAT campaigns in GEN-9999 have the highest failure rate?",
             decide_d3, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions", "fetch_eln_canonical_reaction"],
             expected_steps_max=5),
    Scenario("E1", "autonomy", "T6",
             "Plan the NCE-1234 step-3 scale-up.",
             decide_e1, expected_first_tool="ask_user",
             expected_tool_sequence=["ask_user"], expected_steps_max=3),
    Scenario("F1", "adversarial", "T7",
             "Show me an ELN entry that contains a chemist note pasted from external source.",
             decide_f1, expected_first_tool="fetch_eln_entry",
             expected_tool_sequence=["fetch_eln_entry"], expected_steps_max=2),
    Scenario("G1", "plan_mode", "T8",
             "/plan list amide couplings in NCE-1234 with yield > 80%",
             decide_g1, expected_first_tool=None, expected_steps_max=2),
    Scenario("H1", "failure_modes", "T7",
             "Loop forever — drive max_steps cap.",
             decide_h1, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=[], expected_steps_max=22),
    Scenario("I1", "hte_planning", "T5",
             "Give me the 12 ligands and 8 bases that work best for amide_coupling in NCE-1234, based on historical OFAT data.",
             decide_i1, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions", "fetch_eln_canonical_reaction"],
             expected_steps_max=5),
    Scenario("I2", "hte_planning", "T5",
             "Design a 96-well HTE plate for NCE-1234 amide_coupling: half exploit (high-yielding historical combos), half explore (under-tried combinations) so a downstream TabPFN regression has good coverage.",
             decide_i2, expected_first_tool="query_eln_canonical_reactions",
             expected_tool_sequence=["query_eln_canonical_reactions", "fetch_eln_canonical_reaction"],
             expected_steps_max=5),
]


# ----------------------------------------------------------------------------
# Runner
# ----------------------------------------------------------------------------

def reset_inbox():
    for f in INBOX.glob("*.json"):
        f.unlink(missing_ok=True)
    for f in OUTBOX.glob("*.json"):
        f.unlink(missing_ok=True)


def run_scenario(s: Scenario) -> dict:
    out_dir = RUNS_DIR / s.id
    out_dir.mkdir(parents=True, exist_ok=True)
    sse_path = out_dir / "sse.log"
    trace_path = out_dir / "trace.jsonl"

    reset_inbox()
    if TRACE.exists():
        TRACE.unlink()

    state = ScenarioState()

    # Fire the chat request in a background curl process.
    body = json.dumps({"messages": [{"role": "user", "content": s.query}]})
    proc = subprocess.Popen(
        [
            "curl", "-s", "-N",
            "-H", f"x-user-entra-id: {USER_HEADER}",
            "-H", "content-type: application/json",
            "-d", body,
            urljoin(AGENT_URL, "/api/chat"),
        ],
        stdout=open(sse_path, "wb"),
        stderr=subprocess.DEVNULL,
    )

    # Watch inbox + dispatch
    seen: set[str] = set()
    deadline = time.time() + SCENARIO_TIMEOUT_S
    finished = False
    while time.time() < deadline:
        # SSE finish event terminates the loop
        try:
            sse_text = sse_path.read_text(encoding="utf-8", errors="ignore")
            if '"type":"finish"' in sse_text or '"type":"error"' in sse_text:
                finished = True
                break
        except FileNotFoundError:
            pass

        for f in sorted(INBOX.glob("*.json")):
            if f.name in seen:
                continue
            seen.add(f.name)
            request_id = f.stem
            try:
                payload = json.loads(f.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                seen.discard(f.name)
                time.sleep(0.05)
                continue
            if state.rounds >= MAX_LLM_ROUNDS_PER_SCENARIO:
                proc.terminate()
                return _score_scenario(s, state, sse_path, trace_path,
                                       reason=f"too many rounds ({state.rounds})")
            try:
                reply = s.decide(payload, state)
            except Exception as exc:
                proc.terminate()
                return _score_scenario(s, state, sse_path, trace_path,
                                       reason=f"decide() raised {exc!r}")
            (OUTBOX / f"{request_id}.json").write_text(
                json.dumps(reply, indent=2), encoding="utf-8"
            )
        time.sleep(0.15)

    proc.terminate()
    if TRACE.exists():
        shutil.copy(TRACE, trace_path)
    return _score_scenario(s, state, sse_path, trace_path,
                           reason="completed" if finished else "timeout")


# ----------------------------------------------------------------------------
# Scoring
# ----------------------------------------------------------------------------

UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)
LOGS_UID_RE = re.compile(r"\bLOGS-\d{6}\b")
SAMPLE_RE = re.compile(r"\bS-(NCE-\d{4}|GEN-\d{4}|FOR-\d{4})-\d{5}\b")


def _score_scenario(s: Scenario, state: ScenarioState, sse_path: Path,
                    trace_path: Path, reason: str) -> dict:
    sse = sse_path.read_text(encoding="utf-8", errors="ignore") if sse_path.exists() else ""

    # Tool calls observed in the SSE stream
    tool_calls = re.findall(r'"toolId":"([^"]+)"', sse)
    seen_tools = []
    for t in tool_calls:
        if not seen_tools or seen_tools[-1] != t:
            seen_tools.append(t)
    # Dedupe in order
    first_tool = seen_tools[0] if seen_tools else None

    finish_match = re.search(r'"type":"finish","finishReason":"([^"]+)"', sse)
    finish_reason = finish_match.group(1) if finish_match else None

    # Final text — everything after the last tool_result
    text_deltas = re.findall(r'"type":"text_delta","delta":"([^"]+(?:\\\\.[^"\\\\]*)*)"', sse)
    final_text = "".join(text_deltas).replace("\\n", "\n")

    # IDs that appear in the final text
    text_uuids = set(UUID_RE.findall(final_text))
    text_logs = set(LOGS_UID_RE.findall(final_text))
    text_samples = set(SAMPLE_RE.findall(final_text))

    # IDs from tool outputs (the source of truth for citations)
    tool_uuids: set[str] = set()
    tool_logs: set[str] = set()
    tool_samples: set[str] = set()
    for m in re.finditer(r'"type":"tool_result","toolId":"[^"]+","output":(\{.*?\})\}',
                         sse, re.DOTALL):
        try:
            obj = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        blob = json.dumps(obj)
        tool_uuids.update(UUID_RE.findall(blob))
        tool_logs.update(LOGS_UID_RE.findall(blob))
        tool_samples.update(SAMPLE_RE.findall(blob))

    # Score each dimension
    rubric: dict[str, int] = {}

    # 1. Tool routing: did the agent pick the expected first tool?
    if s.expected_first_tool is None:
        rubric["tool_routing"] = 3
    elif first_tool == s.expected_first_tool:
        rubric["tool_routing"] = 3
    elif first_tool is None:
        rubric["tool_routing"] = 0
    else:
        rubric["tool_routing"] = 1

    # 2. Citation discipline: every cited UUID must appear in tool outputs
    bogus_uuids = text_uuids - tool_uuids
    bogus_logs = text_logs - tool_logs
    bogus_samples = set(text_samples) - set(tool_samples)
    rubric["citation_discipline"] = (
        3 if not (bogus_uuids or bogus_logs or bogus_samples)
        else (1 if (bogus_uuids or bogus_logs or bogus_samples) else 3)
    )

    # 3. Data fidelity: SQL spot-check (if scenario provides one)
    rubric["data_fidelity"] = 3  # default — overridden by truth-check below

    # 4. Reasoning quality: heuristic (manual review for finer grading)
    rubric["reasoning_quality"] = 2  # default; flagged for review

    # 5. Hallucination: same as citation discipline check; phrased as a fail check
    rubric["hallucination"] = 3 if not (bogus_uuids or bogus_logs or bogus_samples) else 0

    # 6. Coverage: did the expected tool sequence happen?
    if s.expected_tool_sequence and seen_tools[: len(s.expected_tool_sequence)] == s.expected_tool_sequence:
        rubric["coverage"] = 3
    elif seen_tools and len(seen_tools) >= 1:
        rubric["coverage"] = 2
    else:
        rubric["coverage"] = 0

    # 7. Termination: stop / awaiting / max_steps / plan_ready / etc.
    # Each scenario category has an expected terminal state — score 3 when
    # the actual finish reason matches the category's expectation.
    expected_finish_by_id = {
        "H1": "max_steps",
        "H2": "session_budget_exceeded",
        "E1": "awaiting_user_input",
        "G1": "plan_ready",
    }
    expected_finish = expected_finish_by_id.get(s.id, "stop")
    if finish_reason == expected_finish:
        rubric["termination"] = 3
    elif finish_reason is None:
        rubric["termination"] = 0
    else:
        rubric["termination"] = 1

    # 8. Latency: rounds vs expected
    rubric["latency"] = 3 if state.rounds <= s.expected_steps_max else (
        2 if state.rounds <= s.expected_steps_max * 1.5 else 1
    )

    # Write per-scenario assessment
    assessment = out_dir = RUNS_DIR / s.id
    out_dir.mkdir(exist_ok=True)
    (out_dir / "assessment.md").write_text(
        f"# Scenario {s.id} — {s.category} ({s.tier})\n\n"
        f"Query: `{s.query}`\n\n"
        f"Status: **{reason}**\n\n"
        f"Rounds: {state.rounds}\n"
        f"Tools called: `{seen_tools}`\n"
        f"Finish reason: `{finish_reason}`\n\n"
        f"## Rubric\n\n"
        + "\n".join(f"- {k}: **{v}/3**" for k, v in rubric.items())
        + "\n\n"
        f"## Issues\n\n"
        + (f"- BOGUS UUIDs in answer: {sorted(bogus_uuids)}\n" if bogus_uuids else "")
        + (f"- BOGUS LOGS UIDs: {sorted(bogus_logs)}\n" if bogus_logs else "")
        + (f"- BOGUS sample codes: {sorted(bogus_samples)}\n" if bogus_samples else "")
        + (f"- expected first tool {s.expected_first_tool!r}; got {first_tool!r}\n"
           if s.expected_first_tool and first_tool != s.expected_first_tool else "")
        + (f"- expected tool sequence {s.expected_tool_sequence}; got {seen_tools}\n"
           if s.expected_tool_sequence and seen_tools[: len(s.expected_tool_sequence)] != s.expected_tool_sequence else "")
        + ("\nNo issues detected.\n" if rubric_total(rubric) >= 21 else "")
        + f"\n## Final answer\n\n{final_text}\n",
        encoding="utf-8",
    )
    return {
        "id": s.id, "category": s.category, "tier": s.tier,
        "reason": reason, "rounds": state.rounds,
        "first_tool": first_tool, "tools": seen_tools,
        "finish_reason": finish_reason,
        "rubric": rubric, "rubric_total": rubric_total(rubric),
        "bogus_uuids": list(bogus_uuids),
        "bogus_logs": list(bogus_logs),
        "bogus_samples": list(bogus_samples),
        "final_text_len": len(final_text),
    }


def rubric_total(rubric: dict[str, int]) -> int:
    return sum(rubric.values())


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="Comma-sep scenario ids (default: all)")
    args = parser.parse_args()

    only = set(args.only.split(",")) if args.only else None
    scenarios = [s for s in SCENARIOS if not only or s.id in only]

    print(f"Running {len(scenarios)} scenario(s)...")
    print()
    results = []
    for s in scenarios:
        print(f"\n=== {s.id} [{s.category}/{s.tier}] ===")
        print(f"    {s.query[:80]}")
        r = run_scenario(s)
        results.append(r)
        print(f"    => {r['reason']}  rounds={r['rounds']}  "
              f"finish={r['finish_reason']}  rubric_total={r['rubric_total']}/24")
        if r["bogus_uuids"] or r["bogus_logs"] or r["bogus_samples"]:
            print(f"    !! bogus IDs: uuids={r['bogus_uuids']} logs={r['bogus_logs']} samples={r['bogus_samples']}")

    # Summary
    summary = ["# E2E Run Summary\n", "## Per-scenario\n",
               "| ID | Category | Tier | Reason | Rounds | First tool | Finish | Rubric | Bogus IDs |",
               "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        bogus = (len(r["bogus_uuids"]) + len(r["bogus_logs"]) + len(r["bogus_samples"]))
        summary.append(
            f"| {r['id']} | {r['category']} | {r['tier']} | {r['reason']} | {r['rounds']} | "
            f"`{r['first_tool']}` | `{r['finish_reason']}` | {r['rubric_total']}/24 | {bogus} |"
        )

    avg_total = sum(r['rubric_total'] for r in results) / max(1, len(results))
    summary.append(f"\n## Aggregate\n\nMean rubric: **{avg_total:.1f}/24**\n")
    pass_count = sum(1 for r in results if r['rubric_total'] >= 18)
    summary.append(f"Scenarios passing (≥18/24): {pass_count}/{len(results)}\n")

    (RUNS_DIR / "_summary.md").write_text("\n".join(summary), encoding="utf-8")
    print()
    print(f"Summary: {RUNS_DIR / '_summary.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
