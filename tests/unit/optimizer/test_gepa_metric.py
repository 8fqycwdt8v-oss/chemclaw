"""Tests for GEPA composite metric — Phase E."""

from __future__ import annotations

import pytest
import dspy

from services.optimizer.gepa_runner.metric import (
    _feedback_score,
    _citation_faithfulness_score,
    _golden_score,
    GepaMetric,
)


# ---------------------------------------------------------------------------
# Feedback score
# ---------------------------------------------------------------------------

class TestFeedbackScore:
    def test_up_maps_to_1(self):
        assert _feedback_score("up") == 1.0

    def test_down_maps_to_0(self):
        assert _feedback_score("down") == 0.0

    def test_thumbs_up_alias(self):
        assert _feedback_score("thumbs_up") == 1.0

    def test_none_maps_to_neutral(self):
        assert _feedback_score(None) == 0.5

    def test_unknown_maps_to_neutral(self):
        assert _feedback_score("neutral") == 0.5


# ---------------------------------------------------------------------------
# Citation faithfulness
# ---------------------------------------------------------------------------

class TestCitationFaithfulness:
    def test_no_claims_is_faithful(self):
        score = _citation_faithfulness_score("A simple answer with no IDs.", [])
        assert score == 1.0

    def test_claimed_id_present_in_tool_output(self):
        fact_id = "550e8400-e29b-41d4-a716-446655440000"
        response = f"According to fact {fact_id} the yield is 85%."
        tool_outputs = [{"fact_id": fact_id, "value": "85%"}]
        score = _citation_faithfulness_score(response, tool_outputs)
        assert score == 1.0

    def test_claimed_id_missing_from_tool_output(self):
        fact_id = "550e8400-e29b-41d4-a716-446655440000"
        response = f"According to fact {fact_id} the yield is 85%."
        score = _citation_faithfulness_score(response, [])
        assert score == 0.0

    def test_partial_citation_faithfulness(self):
        id1 = "550e8400-e29b-41d4-a716-446655440001"
        id2 = "550e8400-e29b-41d4-a716-446655440002"
        response = f"Facts {id1} and {id2} confirm the result."
        tool_outputs = [{"fact_id": id1}]
        score = _citation_faithfulness_score(response, tool_outputs)
        assert score == 0.5


# ---------------------------------------------------------------------------
# Golden score
# ---------------------------------------------------------------------------

class TestGoldenScore:
    def _make_stub_module(self, answer: str):
        """Return a stub dspy.Module that always predicts `answer`."""
        class StubPred:
            def __call__(self, **kwargs):
                class Pred:
                    pass
                p = Pred()
                p.answer = answer
                return p
            def predictors(self):
                return []

        return StubPred()

    def test_exact_match_scores_1(self):
        ex = dspy.Example(question="q", answer="ibuprofen synthesis").with_inputs("question")
        module = self._make_stub_module("ibuprofen synthesis via Friedel-Crafts")
        score = _golden_score(module, [ex])
        assert score == 1.0

    def test_no_match_scores_0(self):
        ex = dspy.Example(question="q", answer="ibuprofen synthesis").with_inputs("question")
        module = self._make_stub_module("completely different answer")
        score = _golden_score(module, [ex])
        assert score == 0.0

    def test_empty_examples_returns_0(self):
        module = self._make_stub_module("anything")
        score = _golden_score(module, [])
        assert score == 0.0


# ---------------------------------------------------------------------------
# GepaMetric composite
# ---------------------------------------------------------------------------

class TestGepaMetric:
    def test_perfect_score(self):
        fact_id = "550e8400-e29b-41d4-a716-446655440000"
        metric = GepaMetric(golden_examples=[])

        class Pred:
            answer = f"ibuprofen synthesis {fact_id}"

        ex = dspy.Example(
            question="How to make ibuprofen?",
            answer="ibuprofen synthesis",
            feedback="up",
            tool_outputs=[{"fact_id": fact_id}],
        ).with_inputs("question")

        score = metric(ex, Pred())
        assert score > 0.7

    def test_negative_feedback_lowers_score(self):
        metric = GepaMetric(golden_examples=[])

        class PredUp:
            answer = "correct answer text here"

        class PredDown:
            answer = "correct answer text here"

        ex_up = dspy.Example(
            question="Q?", answer="correct", feedback="up", tool_outputs=[]
        ).with_inputs("question")
        ex_down = dspy.Example(
            question="Q?", answer="correct", feedback="down", tool_outputs=[]
        ).with_inputs("question")

        score_up = metric(ex_up, PredUp())
        score_down = metric(ex_down, PredDown())
        assert score_up > score_down

    def test_score_in_0_1_range(self):
        metric = GepaMetric(golden_examples=[])

        class Pred:
            answer = "something"

        ex = dspy.Example(question="Q?", answer="ans", feedback="up", tool_outputs=[]).with_inputs("question")
        score = metric(ex, Pred())
        assert 0.0 <= score <= 1.0


# ---------------------------------------------------------------------------
# Phase G — Identity-template guard (deep-review #7)
# ---------------------------------------------------------------------------


class TestIdentityTemplateGuard:
    """run_gepa must mark a run as skipped when the optimised module's
    extracted template is byte-identical to the seed — otherwise we
    insert a 'candidate' that's exactly the active prompt, which can
    never beat itself."""

    def test_skipped_when_extracted_matches_seed(self, monkeypatch):
        import dspy
        from unittest.mock import MagicMock
        from services.optimizer.gepa_runner.gepa import run_gepa

        seed = "You are ChemClaw, the knowledge agent."
        examples = [
            dspy.Example(
                question=f"q{i}",
                answer="a",
                feedback="thumbs_up",
                tool_outputs=[],
                query_class="retrosynthesis",
            ).with_inputs("question")
            for i in range(30)
        ]

        class FakeSig:
            instructions = seed

        class FakeModule:
            signature = FakeSig()

            def predictors(self):
                return []

        class FakeOptimizer:
            def __init__(self, *args, **kwargs):
                pass

            def compile(self, student, trainset):
                return FakeModule()

        monkeypatch.setattr(dspy, "GEPA", FakeOptimizer, raising=False)

        result = run_gepa(
            prompt_name="agent.system",
            current_template=seed,
            examples=examples,
            golden_examples=[],
        )

        assert result.skipped is True
        assert "identity" in result.skip_reason.lower()
