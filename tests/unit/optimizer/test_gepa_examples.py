"""Tests for GEPA example building + stratification — Phase E."""

from __future__ import annotations

import dspy
import pytest

from services.optimizer.gepa_runner.examples import (
    classify_question,
    traces_to_examples,
    stratify,
    check_class_minimums,
    MIN_EXAMPLES_PER_CLASS,
)


class TestClassifyQuestion:
    def test_retrosynthesis(self):
        assert classify_question("What retrosynthetic route exists for aspirin?") == "retrosynthesis"

    def test_analytical(self):
        assert classify_question("How do I run HPLC purity analysis?") == "analytical"

    def test_sop_lookup(self):
        assert classify_question("What is the SOP for handling hazardous materials?") == "sop_lookup"

    def test_cross_project_default(self):
        assert classify_question("How do yield outcomes compare across projects?") == "cross_project"

    def test_unknown_defaults_to_cross_project(self):
        # A question with no recognised keywords should default to cross_project.
        assert classify_question("Tell me something general.") == "cross_project"


class TestTracesToExamples:
    def _make_trace(self, tid: str, question: str = "Q?", answer: str = "A.") -> dict:
        return {
            "id": tid,
            "input": {"messages": [{"role": "user", "content": question}]},
            "output": {"answer": answer},
            "observations": [],
        }

    def test_basic_conversion(self):
        traces = [self._make_trace("t1", "What HPLC method for APIs?", "Use C18 reversed-phase.")]
        examples = traces_to_examples(traces, [])
        assert len(examples) == 1
        assert examples[0].question == "What HPLC method for APIs?"

    def test_feedback_merged(self):
        traces = [self._make_trace("t2", "What retro route for aspirin?")]
        feedback = [{"trace_id": "t2", "signal": "up"}]
        examples = traces_to_examples(traces, feedback)
        assert examples[0].feedback == "up"

    def test_missing_question_skipped(self):
        trace = {
            "id": "t3",
            "input": {"messages": []},
            "output": {"answer": "A."},
            "observations": [],
        }
        examples = traces_to_examples([trace], [])
        assert len(examples) == 0

    def test_query_class_assigned(self):
        traces = [self._make_trace("t4", "What HPLC method?")]
        examples = traces_to_examples(traces, [])
        assert examples[0].query_class == "analytical"


class TestStratify:
    def _make_ex(self, cls: str) -> dspy.Example:
        return dspy.Example(question="q", answer="a", query_class=cls).with_inputs("question")

    def test_groups_by_class(self):
        examples = [self._make_ex("retrosynthesis"), self._make_ex("analytical")]
        groups = stratify(examples)
        assert len(groups["retrosynthesis"]) == 1
        assert len(groups["analytical"]) == 1

    def test_empty_classes_present(self):
        groups = stratify([])
        assert "sop_lookup" in groups
        assert len(groups["sop_lookup"]) == 0


class TestCheckClassMinimums:
    def test_meets_minimum(self):
        groups = {"retrosynthesis": [object()] * MIN_EXAMPLES_PER_CLASS}
        result = check_class_minimums(groups)
        assert result["retrosynthesis"] is True

    def test_below_minimum(self):
        groups = {"analytical": [object()] * (MIN_EXAMPLES_PER_CLASS - 1)}
        result = check_class_minimums(groups)
        assert result["analytical"] is False


# ---------------------------------------------------------------------------
# Phase G — scoring-based classify_question + broader obs.type filter
# ---------------------------------------------------------------------------


class TestClassifyQuestionScoring:
    """First-keyword-match-wins biases the training distribution toward
    whichever class has the highest-frequency keyword. Scoring counts
    keyword hits per class and picks argmax."""

    def test_cross_project_dominates_when_more_keywords_match(self):
        from services.optimizer.gepa_runner.examples import classify_question

        # 1 retrosynthesis keyword (retro), 3 cross_project (compare,
        # multiple, project).
        q = "Compare retro routes across multiple projects in our portfolio"
        assert classify_question(q) == "cross_project"

    def test_falls_back_to_cross_project_when_no_keywords(self):
        from services.optimizer.gepa_runner.examples import classify_question
        assert classify_question("hello world") == "cross_project"

    def test_single_strong_signal_picks_that_class(self):
        from services.optimizer.gepa_runner.examples import classify_question
        assert classify_question("Optimise HPLC method for impurity X") == "analytical"


class TestTraceObservationTypes:
    """Langfuse OTel records observations with type='SPAN' (uppercase) or
    'GENERATION' (LLM calls). The original lowercase 'span' filter never
    matched real traces; tool_outputs ended up empty."""

    def test_accepts_uppercase_span(self):
        from services.optimizer.gepa_runner.examples import traces_to_examples

        traces = [
            {
                "id": "t1",
                "input": {"messages": [{"role": "user", "content": "What HPLC method?"}]},
                "output": {"answer": "Use C18 column"},
                "observations": [
                    {"type": "SPAN", "output": {"fact_id": "abc123"}},
                ],
            }
        ]
        examples = traces_to_examples(traces, [])
        assert len(examples) == 1
        assert examples[0].tool_outputs == [{"fact_id": "abc123"}]

    def test_accepts_generation_type(self):
        from services.optimizer.gepa_runner.examples import traces_to_examples

        traces = [
            {
                "id": "t1",
                "input": {"messages": [{"role": "user", "content": "What HPLC method?"}]},
                "output": {"answer": "Use C18 column"},
                "observations": [
                    {"type": "GENERATION", "output": {"fact_id": "xyz789"}},
                ],
            }
        ]
        examples = traces_to_examples(traces, [])
        assert examples[0].tool_outputs == [{"fact_id": "xyz789"}]
