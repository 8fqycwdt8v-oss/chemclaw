"""DSPy GEPA optimizer wrapper for ChemClaw prompt evolution.

Algorithm (per prompt_registry row):
  1. Build DSPy Examples from Langfuse traces + feedback_events.
  2. Stratify; skip if any class has < 30 examples.
  3. Run dspy.GEPA for 30 generations, population 8.
  4. Score best candidate on golden-set fixture.
  5. INSERT new prompt_registry row (active=false, shadow_until=NOW()+7d).

This module is kept pure-function / mockable for testing.
Only the runner.py touches the DB and scheduler.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import dspy

from .examples import stratify, check_class_minimums
from .metric import GepaMetric, _golden_score

logger = logging.getLogger(__name__)

# Canonical positive feedback signals — matches feedback_events.signal
# CHECK constraint plus the legacy short-form aliases.
_POSITIVE_FEEDBACK = frozenset({"up", "thumbs_up", "+1", "1", "implicit_positive"})

# ---------------------------------------------------------------------------
# DSPy Signature
# ---------------------------------------------------------------------------

class ChemClawQA(dspy.Signature):
    """Answer a chemistry / pharmaceutical development question precisely and
    with full citations to fact IDs from the knowledge graph."""

    question: str = dspy.InputField(desc="The user's chemistry or analytical development question.")
    answer: str = dspy.OutputField(desc="Detailed answer with citations (fact IDs as UUIDs).")


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------

@dataclass
class GepaResult:
    prompt_name: str
    new_template: str
    golden_score: float
    feedback_rate: float
    per_class_breakdown: dict[str, int]
    gepa_metadata: dict[str, Any]
    skipped: bool = False
    skip_reason: str = ""


# ---------------------------------------------------------------------------
# Core optimizer call
# ---------------------------------------------------------------------------

def run_gepa(
    prompt_name: str,
    current_template: str,
    examples: list[dspy.Example],
    golden_examples: list[dspy.Example],
    *,
    generations: int = 30,
    population_size: int = 8,
    dspy_lm: Any = None,
) -> GepaResult:
    """Run GEPA optimisation for a single prompt.

    Parameters
    ----------
    prompt_name:
        The name key in prompt_registry.
    current_template:
        The current active prompt text (used as GEPA seed).
    examples:
        Training examples (traces + feedback from Langfuse).
    golden_examples:
        Golden-set fixture examples for scoring.
    generations / population_size:
        GEPA hyperparameters.
    dspy_lm:
        Configured DSPy LM instance.  Injected so tests can stub it.
    """
    # Stratify + check minimums.
    groups = stratify(examples)
    minimums = check_class_minimums(groups)
    per_class_breakdown = {cls: len(exs) for cls, exs in groups.items()}

    if not any(minimums.values()):
        return GepaResult(
            prompt_name=prompt_name,
            new_template=current_template,
            golden_score=0.0,
            feedback_rate=0.0,
            per_class_breakdown=per_class_breakdown,
            gepa_metadata={},
            skipped=True,
            skip_reason="no class met minimum example count (30)",
        )

    # Configure DSPy LM if not injected (used in production).
    if dspy_lm is not None:
        dspy.settings.configure(lm=dspy_lm)

    metric = GepaMetric(golden_examples=golden_examples)

    # Build the trainset from classes that meet the minimum.
    trainset: list[dspy.Example] = []
    for cls, exs in groups.items():
        if minimums.get(cls):
            trainset.extend(exs)

    # Build baseline module.
    baseline = dspy.Predict(ChemClawQA)

    # Run GEPA.
    try:
        gepa_optimizer = dspy.GEPA(
            metric=metric,
            num_generations=generations,
            population_size=population_size,
        )
        optimized: dspy.Module = gepa_optimizer.compile(
            student=baseline,
            trainset=trainset,
        )
    except AttributeError:
        # dspy.GEPA may not exist in all versions — fall back to BootstrapFewShotWithRandomSearch.
        logger.warning(
            "dspy.GEPA not available; falling back to BootstrapFewShotWithRandomSearch"
        )
        gepa_optimizer = dspy.BootstrapFewShotWithRandomSearch(
            metric=metric,
            num_candidates=population_size,
            num_threads=1,
        )
        optimized = gepa_optimizer.compile(
            student=baseline,
            trainset=trainset,
        )

    # Score on golden set.
    golden_score = _golden_score(optimized, golden_examples)

    # Compute feedback rate.
    positive_feedback = sum(
        1 for ex in examples
        if getattr(ex, "feedback", "") in _POSITIVE_FEEDBACK
    )
    feedback_rate = positive_feedback / len(examples) if examples else 0.0

    # Extract the optimised prompt text from the module's predictors.
    new_template = _extract_template(optimized, current_template)

    # Guard against the "extraction returned the seed" path. DSPy's Predict
    # exposes the *signature docstring* via pred.signature.instructions; if
    # the optimiser failed to evolve a meaningfully different prompt (or if
    # _extract_template walked off into a dead branch), inserting that
    # value as a "candidate" produces a row that is byte-identical to the
    # active version. Such a row can never beat the active prompt in
    # shadow scoring (it's the same prompt) and just clutters the registry.
    if _is_identity_template(new_template, current_template):
        return GepaResult(
            prompt_name=prompt_name,
            new_template=current_template,
            golden_score=0.0,
            feedback_rate=feedback_rate,
            per_class_breakdown=per_class_breakdown,
            gepa_metadata={"reason": "identity_template"},
            skipped=True,
            skip_reason="identity template — optimiser returned the seed",
        )

    gepa_metadata: dict[str, Any] = {
        "generations": generations,
        "population_size": population_size,
        "golden_score": golden_score,
        "feedback_rate": feedback_rate,
        "per_class_breakdown": per_class_breakdown,
        "training_examples": len(trainset),
        "classes_met_minimum": [cls for cls, ok in minimums.items() if ok],
    }

    return GepaResult(
        prompt_name=prompt_name,
        new_template=new_template,
        golden_score=golden_score,
        feedback_rate=feedback_rate,
        per_class_breakdown=per_class_breakdown,
        gepa_metadata=gepa_metadata,
    )


# ---------------------------------------------------------------------------
# Template extraction
# ---------------------------------------------------------------------------

def _extract_template(module: dspy.Module, fallback: str) -> str:
    """Pull the first system instruction from an optimised DSPy module.

    DSPy stores instructions on different attributes across versions:
      * ``pred.signature.instructions`` (>=2.5)
      * ``pred.extended_signature.instructions`` (older bootstrap path)
      * ``pred.instructions`` (some optimisers attach it directly)
      * ``module.signature.instructions`` (when the module wraps a single signature)
    Walk all of them; return ``fallback`` only if none are populated.
    """
    try:
        candidates: list[Any] = []
        sig = getattr(module, "signature", None)
        if sig is not None:
            candidates.append(sig)
        try:
            for pred in module.predictors():
                candidates.append(pred)
                for attr in ("signature", "extended_signature"):
                    sub = getattr(pred, attr, None)
                    if sub is not None:
                        candidates.append(sub)
        except Exception:
            pass
        for c in candidates:
            instructions = getattr(c, "instructions", None)
            if isinstance(instructions, str) and instructions.strip():
                return instructions
    except Exception:
        logger.exception("_extract_template traversal failed")
    return fallback


def _is_identity_template(candidate: str, seed: str) -> bool:
    """Return True if the candidate is the same prompt as the seed.

    Compares on stripped content so trailing whitespace differences
    don't accidentally pass. Doesn't normalise case — instruction
    case can be semantically meaningful.
    """
    return candidate.strip() == seed.strip()
