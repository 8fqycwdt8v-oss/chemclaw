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
    q_lower = question.lower()
    for cls, kws in _CLASS_KEYWORDS.items():
        if any(kw in q_lower for kw in kws):
            return cls
    return "cross_project"  # default


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
        tool_outputs: list[dict[str, Any]] = []
        for obs in trace.get("observations") or []:
            if isinstance(obs, dict) and obs.get("type") == "span":
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
