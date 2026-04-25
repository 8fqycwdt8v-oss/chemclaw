"""Composite GEPA metric for ChemClaw prompt evaluation.

Composite score:
  50% — feedback signal (up=+1, down=-1, neutral=0) averaged across examples.
  30% — golden-set score (candidate prompt scored on fixture examples).
  20% — citation faithfulness (every claimed fact_id must appear in tool outputs).

All components are normalised to [0, 1] before weighting.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import dspy

# ---------------------------------------------------------------------------
# Weights
# ---------------------------------------------------------------------------

FEEDBACK_WEIGHT = 0.50
GOLDEN_WEIGHT = 0.30
CITATION_WEIGHT = 0.20

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FACT_ID_RE = re.compile(r'\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b', re.I)


def _feedback_score(feedback: str | None) -> float:
    """Map feedback signal to [-1, +1] then normalise to [0, 1]."""
    raw = 0.0
    if feedback in ("up", "thumbs_up", "+1", "1"):
        raw = 1.0
    elif feedback in ("down", "thumbs_down", "-1", "-1"):
        raw = -1.0
    return (raw + 1.0) / 2.0  # map to [0, 1]


def _citation_faithfulness_score(response: str, tool_outputs: list[dict[str, Any]]) -> float:
    """Check that every UUID-looking fact_id in the response appears in tool_outputs."""
    claimed_ids = set(_FACT_ID_RE.findall(response))
    if not claimed_ids:
        return 1.0  # no claims → trivially faithful

    available_ids: set[str] = set()
    for output in tool_outputs:
        text = json.dumps(output).lower()
        available_ids.update(m.lower() for m in _FACT_ID_RE.findall(text))

    claimed_lower = {c.lower() for c in claimed_ids}
    faithful = claimed_lower & available_ids
    return len(faithful) / len(claimed_lower) if claimed_lower else 1.0


def _golden_score(
    candidate: dspy.Module,
    examples: list[dspy.Example],
) -> float:
    """Score candidate module on golden examples — exact or partial string match."""
    if not examples:
        return 0.0

    correct = 0
    for ex in examples:
        try:
            pred = candidate(question=ex.question)
            predicted_answer = str(getattr(pred, "answer", "") or "").lower()
            expected = str(ex.answer or "").lower()
            # Partial-match: expected text appears in prediction.
            if expected and expected[:80] in predicted_answer:
                correct += 1
        except Exception:
            pass

    return correct / len(examples)


# ---------------------------------------------------------------------------
# DSPy metric callable
# ---------------------------------------------------------------------------

class GepaMetric:
    """DSPy-compatible metric.  Called by the GEPA optimiser after each candidate generation.

    Parameters
    ----------
    golden_examples:
        Subset of golden Q/A pairs available to the optimiser (NOT the held-out set).
    """

    def __init__(self, golden_examples: list[dspy.Example]) -> None:
        self.golden_examples = golden_examples

    def __call__(
        self,
        example: dspy.Example,
        prediction: Any,
        trace: list[Any] | None = None,
    ) -> float:
        """Return a composite score in [0, 1] for a single (example, prediction) pair."""
        # --- feedback component ---
        fb = _feedback_score(getattr(example, "feedback", None))

        # --- citation component ---
        response_text = str(getattr(prediction, "answer", "") or "")
        tool_outputs: list[dict[str, Any]] = list(getattr(example, "tool_outputs", None) or [])
        cite = _citation_faithfulness_score(response_text, tool_outputs)

        # --- golden component: score the *prediction* for this example inline ---
        expected = str(getattr(example, "answer", "") or "").lower()
        golden = float(
            bool(expected) and expected[:80] in response_text.lower()
        )

        composite = (
            FEEDBACK_WEIGHT * fb
            + GOLDEN_WEIGHT * golden
            + CITATION_WEIGHT * cite
        )
        return round(composite, 4)
