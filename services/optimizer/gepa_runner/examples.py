"""Convert Langfuse traces + feedback_events rows to DSPy Examples.

Query taxonomy (4 classes):
  retrosynthesis   — route-finding, reaction similarity
  analytical       — method selection, QC, chromatography
  sop_lookup       — procedure retrieval, SOP queries
  cross_project    — multi-project synthesis, hypothesis comparison

Minimum 30 examples per class required for a GEPA run to proceed.
"""

from __future__ import annotations

import json
from typing import Any

import dspy

MIN_EXAMPLES_PER_CLASS = 30

# Langfuse observation types that carry tool/LLM outputs we want to harvest
# for the citation-faithfulness component. Historical lower-case 'span' was a
# misread of the SDK shape; broaden so real OTel traces actually score.
_TOOL_OUTPUT_TYPES = frozenset({"span", "SPAN", "GENERATION", "EVENT"})

# ---------------------------------------------------------------------------
# Class detection (simple keyword heuristic — good enough for stratification)
# ---------------------------------------------------------------------------

_CLASS_KEYWORDS: dict[str, list[str]] = {
    "retrosynthesis": ["retro", "route", "synth", "smiles", "reaction", "reagent"],
    "analytical": ["hplc", "nmr", "ms ", "analytical", "method", "qc", "purity", "assay", "chrom"],
    "sop_lookup": ["sop", "procedure", "protocol", "standard", "operating", "guidance", "policy"],
    "cross_project": ["cross", "project", "hypothesis", "compare", "multiple", "learn"],
}


def classify_question(question: str) -> str:
    """Score the question against each class's keyword set; return the
    argmax class. Ties resolve to cross_project (the catch-all). When no
    class has any matches we also return cross_project — the same
    fallback as before, just stated explicitly.

    Replaces the historical first-match-wins behaviour, which biased
    everything mentioning a chemistry term toward `retrosynthesis`
    (the first dict entry) and starved `cross_project` of training
    examples.
    """
    q_lower = question.lower()
    scores: dict[str, int] = {}
    for cls, kws in _CLASS_KEYWORDS.items():
        scores[cls] = sum(1 for kw in kws if kw in q_lower)

    best_score = max(scores.values()) if scores else 0
    if best_score == 0:
        return "cross_project"

    # Argmax with deterministic tie-break: prefer cross_project, then
    # alphabetical so replays / tests are stable.
    best = [cls for cls, s in scores.items() if s == best_score]
    if "cross_project" in best:
        return "cross_project"
    return sorted(best)[0]


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

def traces_to_examples(
    traces: list[dict[str, Any]],
    feedback_rows: list[dict[str, Any]],
) -> list[dspy.Example]:
    """Merge Langfuse traces + feedback_events rows into DSPy Example objects."""
    # Build a fast lookup: trace_id → feedback signal.
    feedback_by_trace: dict[str, str] = {}
    for row in feedback_rows:
        tid = str(row.get("trace_id") or "")
        sig = str(row.get("signal") or "")
        if tid:
            feedback_by_trace[tid] = sig

    examples: list[dspy.Example] = []
    for trace in traces:
        trace_id = str(trace.get("id") or "")
        # Extract question from the first user message in the trace input.
        input_payload = trace.get("input") or {}
        if isinstance(input_payload, str):
            try:
                input_payload = json.loads(input_payload)
            except Exception:
                input_payload = {}
        messages = input_payload.get("messages", [])
        question = ""
        for msg in messages:
            if isinstance(msg, dict) and msg.get("role") == "user":
                question = str(msg.get("content") or "")
                break

        if not question:
            continue

        # Extract answer from trace output.
        output_payload = trace.get("output") or {}
        if isinstance(output_payload, str):
            try:
                output_payload = json.loads(output_payload)
            except Exception:
                output_payload = {}
        answer = str(output_payload.get("answer") or output_payload.get("text") or "")

        # Extract tool outputs from trace observations.
        # Langfuse OTel ingestion records observations with type='SPAN'
        # (generic) or 'GENERATION' (LLM calls); historical lower-case
        # 'span' was a misread of the SDK shape and never matched real
        # traces, leaving tool_outputs empty and trivialising the
        # citation-faithfulness component.
        tool_outputs: list[dict[str, Any]] = []
        for obs in trace.get("observations") or []:
            if not isinstance(obs, dict):
                continue
            if obs.get("type") not in _TOOL_OUTPUT_TYPES:
                continue
            out = obs.get("output")
            if isinstance(out, dict):
                tool_outputs.append(out)

        feedback = feedback_by_trace.get(trace_id, "")
        query_class = classify_question(question)

        ex = dspy.Example(
            question=question,
            answer=answer,
            feedback=feedback,
            tool_outputs=tool_outputs,
            query_class=query_class,
            trace_id=trace_id,
        ).with_inputs("question")

        examples.append(ex)

    return examples


def stratify(examples: list[dspy.Example]) -> dict[str, list[dspy.Example]]:
    """Group examples by query_class."""
    groups: dict[str, list[dspy.Example]] = {cls: [] for cls in _CLASS_KEYWORDS}
    for ex in examples:
        cls = str(getattr(ex, "query_class", "cross_project"))
        groups.setdefault(cls, []).append(ex)
    return groups


def check_class_minimums(groups: dict[str, list[dspy.Example]]) -> dict[str, bool]:
    """Return {class: meets_minimum}."""
    return {cls: len(exs) >= MIN_EXAMPLES_PER_CLASS for cls, exs in groups.items()}
