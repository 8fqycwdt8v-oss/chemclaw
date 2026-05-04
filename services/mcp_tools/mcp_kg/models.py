"""Domain model for the knowledge graph service.

Bi-temporal edges carry t_valid_from / t_valid_to and recorded_at /
invalidated_at. Confidence is bucketed into tiers (matching the plan's
Deliverable 2 confidence model). Every edge MUST carry provenance.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)


class ConfidenceTier(StrEnum):
    EXPERT_VALIDATED = "expert_validated"
    MULTI_SOURCE_LLM = "multi_source_llm"
    SINGLE_SOURCE_LLM = "single_source_llm"
    EXPERT_DISPUTED = "expert_disputed"
    INVALIDATED = "invalidated"


#: Upper bound on string properties written to the KG. Anything longer is
#: almost certainly a logic error upstream; reject early.
_MAX_STR = 4000
SafeStr = Annotated[str, StringConstraints(min_length=1, max_length=_MAX_STR)]

#: Identifier-shaped strings (labels, predicates). Tight shape to prevent
#: accidental injection through label interpolation in Cypher.
LabelStr = Annotated[
    str,
    StringConstraints(
        min_length=1, max_length=80, pattern=r"^[A-Z][A-Za-z0-9_]*$"
    ),
]
PredicateStr = Annotated[
    str,
    StringConstraints(
        min_length=1, max_length=80, pattern=r"^[A-Z][A-Z0-9_]*$"
    ),
]

#: Tenant-scope identifier for KG facts. Postgres has RLS scoped by
#: `app.current_user_entra_id`; the Neo4j layer mirrors that via a `group_id`
#: edge property on every fact. Existing callers that aren't yet aware of
#: tenant scoping default to the `'__system__'` sentinel (matching the
#: Postgres SYSTEM_USER_ENTRA_ID convention) so the rollout is non-breaking;
#: a dedicated `__legacy__` value is reserved for backfilled rows where the
#: original tenant is unknown. Never accept an unbounded string here — it
#: ends up interpolated as a property value, so size + charset must be
#: constrained to keep audit and indexing predictable.
GroupIdStr = Annotated[
    str,
    StringConstraints(
        min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_\-]+$"
    ),
]

#: Sentinel used by callers that haven't yet adopted explicit tenant scoping.
#: Treated as a single shared tenant; production callers MUST switch to a
#: real project / org identifier (Tranche 2 of the KG refactor closes the
#: remaining direct-Neo4j writers to ensure no caller defaults to this).
SYSTEM_GROUP_ID: str = "__system__"


class Provenance(BaseModel):
    """Required provenance on every fact."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    source_type: Literal[
        "ELN", "SOP", "literature", "analytical",
        "user_correction", "agent_inference", "import_tool",
    ]
    source_id: SafeStr
    extracted_by_agent_run_id: UUID | None = None
    extractor_model_version: Annotated[str, StringConstraints(max_length=200)] | None = None
    extraction_prompt_version: Annotated[str, StringConstraints(max_length=200)] | None = None


class EntityRef(BaseModel):
    """Reference to a graph node by a stable identifier.

    Callers pass `label` + the value of the node's primary identifier
    property (`id_property`). E.g. Compound.inchikey, Experiment.uuid,
    NCEProject.internal_id.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    label: LabelStr
    id_property: Annotated[str, StringConstraints(min_length=1, max_length=40, pattern=r"^[a-z_]+$")]
    id_value: SafeStr


class WriteFactRequest(BaseModel):
    """Create a new fact edge, OR create+link nodes when they don't exist.

    If `subject` or `object` nodes don't already exist, we create them with
    their primary identifier property set. Additional properties can be
    supplied via `subject_properties` / `object_properties`.
    """

    model_config = ConfigDict(extra="forbid")

    subject: EntityRef
    object: EntityRef
    predicate: PredicateStr

    # Tenant scope. Defaults to SYSTEM_GROUP_ID for backward compatibility
    # during the Tranche 1 rollout; new callers should pass the canonical
    # project / org identifier so reads from other tenants don't surface the
    # fact.
    group_id: GroupIdStr = SYSTEM_GROUP_ID

    # Optional free-form properties on nodes (only applied on CREATE; we
    # never overwrite existing node properties via write_fact — corrections
    # go through a dedicated endpoint).
    subject_properties: dict[str, Any] | None = None
    object_properties: dict[str, Any] | None = None

    # Optional properties on the edge (e.g., {"tanimoto": 0.87} on SIMILAR_TO).
    edge_properties: dict[str, Any] | None = None

    confidence_tier: ConfidenceTier = ConfidenceTier.SINGLE_SOURCE_LLM
    confidence_score: Annotated[float, Field(ge=0.0, le=1.0)] = 0.5

    t_valid_from: AwareDatetime | None = None  # defaults to "now" server-side

    provenance: Provenance

    # Optional stable fact_id: idempotency key. If provided and already
    # present in the KG, write_fact is a no-op.
    fact_id: UUID | None = None

    @model_validator(mode="after")
    def _props_only_scalar(self) -> WriteFactRequest:
        """Reject non-scalar values inside property dicts to keep Cypher
        parameterisation safe and the graph queryable. Nested objects
        belong in their own nodes."""
        for name, obj in (
            ("subject_properties", self.subject_properties),
            ("object_properties", self.object_properties),
            ("edge_properties", self.edge_properties),
        ):
            if obj is None:
                continue
            for k, v in obj.items():
                if not isinstance(k, str) or len(k) > 80:
                    raise ValueError(f"{name}: key {k!r} invalid (max 80 chars str)")
                if not isinstance(v, (str, int, float, bool, type(None))):
                    raise ValueError(
                        f"{name}[{k!r}]: only scalar values permitted (got {type(v).__name__})"
                    )
                if isinstance(v, str) and len(v) > _MAX_STR:
                    raise ValueError(f"{name}[{k!r}]: string too long")
        return self


class WriteFactResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fact_id: UUID
    created: bool  # True if new; False if the fact_id already existed
    t_valid_from: AwareDatetime
    recorded_at: AwareDatetime


class InvalidateFactRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fact_id: UUID
    reason: SafeStr
    invalidated_by_provenance: Provenance
    t_valid_to: AwareDatetime | None = None  # defaults to "now"
    new_confidence_tier: ConfidenceTier = ConfidenceTier.INVALIDATED

    # Tenant scope. The lookup MATCHes the fact_id and additionally enforces
    # that the caller's tenant matches; cross-tenant invalidation is denied
    # at the query layer rather than the application layer.
    group_id: GroupIdStr = SYSTEM_GROUP_ID


class InvalidateFactResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fact_id: UUID
    invalidated_at: AwareDatetime
    was_already_invalid: bool


class QueryAtTimeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity: EntityRef
    predicate: PredicateStr | None = None  # None = all predicates
    direction: Literal["out", "in", "both"] = "both"
    at_time: AwareDatetime | None = None  # None = "now"
    include_invalidated: bool = False

    # Tenant scope. The query filters edges to those carrying a matching
    # `group_id`; without this filter a user with access to project A would
    # see facts written by project B (Postgres RLS is enforced upstream, but
    # Neo4j has no equivalent — this property closes that gap).
    group_id: GroupIdStr = SYSTEM_GROUP_ID


class QueriedFact(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fact_id: UUID
    subject: EntityRef
    predicate: PredicateStr
    object: EntityRef
    edge_properties: dict[str, Any]
    confidence_tier: ConfidenceTier
    confidence_score: float
    t_valid_from: AwareDatetime
    t_valid_to: AwareDatetime | None
    recorded_at: AwareDatetime
    provenance: Provenance


class QueryAtTimeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    facts: list[QueriedFact]


# ---------------------------------------------------------------------------
# Tranche 3 / H4 — provenance lookup
# ---------------------------------------------------------------------------
class GetFactProvenanceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fact_id: UUID
    group_id: GroupIdStr = SYSTEM_GROUP_ID


class GetFactProvenanceResponse(BaseModel):
    """The full provenance + bi-temporal envelope for a fact_id.

    Tranche 3 / H4: today this is the structured `Provenance` blob the
    write_fact path attached to the edge, plus the bi-temporal columns and
    confidence tier. Once Tranche 5 lands the kg_documents projector and
    wires up :Chunk / :Extractor / :Document nodes with explicit
    DERIVED_FROM / EXTRACTED_BY / FROM_DOCUMENT relationships, this
    response gains a `chain[]` field that walks the graph; the per-edge
    provenance fields below stay as the foundation.
    """

    model_config = ConfigDict(extra="forbid")
    fact_id: UUID
    subject: EntityRef
    predicate: PredicateStr
    object: EntityRef
    provenance: Provenance
    confidence_tier: ConfidenceTier
    confidence_score: float
    t_valid_from: AwareDatetime
    t_valid_to: AwareDatetime | None
    recorded_at: AwareDatetime
    invalidated_at: AwareDatetime | None
    invalidation_reason: str | None


def utcnow() -> datetime:
    """UTC-aware current time. Centralised so we can monkey-patch in tests."""
    return datetime.now(tz=timezone.utc)


def new_fact_id() -> UUID:
    return uuid4()
