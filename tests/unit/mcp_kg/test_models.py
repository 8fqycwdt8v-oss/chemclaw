"""Unit tests for mcp_kg Pydantic domain models.

These tests are pure — no Neo4j. They lock down:
- Input validation (label/predicate shape enforced, string length bounded)
- Non-scalar property values rejected
- Enum tiers honored
- Frozen invariants
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from services.mcp_tools.mcp_kg.models import (
    ConfidenceTier,
    EntityRef,
    InvalidateFactRequest,
    Provenance,
    QueryAtTimeRequest,
    WriteFactRequest,
)


def _entity(label: str = "Compound", prop: str = "inchikey", val: str = "XXX") -> EntityRef:
    return EntityRef(label=label, id_property=prop, id_value=val)


def _provenance() -> Provenance:
    return Provenance(source_type="ELN", source_id="ELN-0001")


def _valid_write_fact_request() -> WriteFactRequest:
    return WriteFactRequest(
        subject=_entity(),
        object=_entity(label="Reaction", prop="uuid", val="11111111-1111-1111-1111-111111111111"),
        predicate="IS_REAGENT_IN",
        provenance=_provenance(),
    )


class TestEntityRef:
    def test_valid(self) -> None:
        e = _entity()
        assert e.label == "Compound"
        assert e.id_value == "XXX"

    @pytest.mark.parametrize("bad_label", ["compound", "Comp ound", "1Compound", "", "A" * 81])
    def test_rejects_invalid_labels(self, bad_label: str) -> None:
        with pytest.raises(ValidationError):
            EntityRef(label=bad_label, id_property="inchikey", id_value="X")

    @pytest.mark.parametrize("bad_prop", ["Inchikey", "id-value", "id value", ""])
    def test_rejects_invalid_id_property(self, bad_prop: str) -> None:
        with pytest.raises(ValidationError):
            EntityRef(label="Compound", id_property=bad_prop, id_value="X")

    def test_frozen(self) -> None:
        e = _entity()
        with pytest.raises(ValidationError):
            e.label = "X"  # type: ignore[misc]


class TestProvenance:
    def test_valid(self) -> None:
        p = _provenance()
        assert p.source_type == "ELN"

    def test_unknown_source_type_rejected(self) -> None:
        with pytest.raises(ValidationError):
            Provenance(source_type="OTHER", source_id="X")  # type: ignore[arg-type]

    def test_source_id_required(self) -> None:
        with pytest.raises(ValidationError):
            Provenance(source_type="ELN", source_id="")


class TestWriteFactRequest:
    def test_valid(self) -> None:
        req = _valid_write_fact_request()
        assert req.confidence_tier == ConfidenceTier.SINGLE_SOURCE_LLM
        assert req.confidence_score == 0.5

    def test_invalid_predicate_shape(self) -> None:
        with pytest.raises(ValidationError):
            WriteFactRequest(
                subject=_entity(),
                object=_entity(label="X"),
                predicate="has a reagent",
                provenance=_provenance(),
            )

    def test_confidence_score_out_of_range(self) -> None:
        with pytest.raises(ValidationError):
            WriteFactRequest(
                subject=_entity(),
                object=_entity(label="X"),
                predicate="X_X",
                confidence_score=1.5,
                provenance=_provenance(),
            )

    def test_rejects_nonscalar_property_values(self) -> None:
        with pytest.raises(ValidationError):
            WriteFactRequest(
                subject=_entity(),
                object=_entity(label="X"),
                predicate="X_X",
                edge_properties={"nested": {"a": 1}},
                provenance=_provenance(),
            )

    def test_accepts_scalar_properties(self) -> None:
        req = WriteFactRequest(
            subject=_entity(),
            object=_entity(label="Reaction"),
            predicate="IS_REAGENT_IN",
            edge_properties={"stoichiometry": 1.2, "equiv": 2.0, "is_limiting": True, "note": "a"},
            provenance=_provenance(),
        )
        assert req.edge_properties and req.edge_properties["stoichiometry"] == 1.2

    def test_rejects_overlong_property_key(self) -> None:
        with pytest.raises(ValidationError):
            WriteFactRequest(
                subject=_entity(),
                object=_entity(label="Reaction"),
                predicate="P",
                edge_properties={"x" * 81: 1},
                provenance=_provenance(),
            )


class TestInvalidateFactRequest:
    def test_valid(self) -> None:
        req = InvalidateFactRequest(
            fact_id="11111111-1111-1111-1111-111111111111",
            reason="contradicted by EXP-999",
            invalidated_by_provenance=_provenance(),
        )
        assert req.new_confidence_tier == ConfidenceTier.INVALIDATED

    def test_rejects_empty_reason(self) -> None:
        with pytest.raises(ValidationError):
            InvalidateFactRequest(
                fact_id="11111111-1111-1111-1111-111111111111",
                reason="",
                invalidated_by_provenance=_provenance(),
            )


class TestQueryAtTimeRequest:
    def test_defaults(self) -> None:
        req = QueryAtTimeRequest(entity=_entity())
        assert req.direction == "both"
        assert req.include_invalidated is False
        assert req.at_time is None

    def test_direction_enum(self) -> None:
        with pytest.raises(ValidationError):
            QueryAtTimeRequest(entity=_entity(), direction="up")  # type: ignore[arg-type]

    def test_naive_datetime_rejected(self) -> None:
        # AwareDatetime rejects timezone-naive values.
        with pytest.raises(ValidationError):
            QueryAtTimeRequest(entity=_entity(), at_time=datetime(2026, 1, 1))  # type: ignore[arg-type]

    def test_aware_datetime_accepted(self) -> None:
        req = QueryAtTimeRequest(
            entity=_entity(), at_time=datetime(2026, 1, 1, tzinfo=timezone.utc)
        )
        assert req.at_time is not None
