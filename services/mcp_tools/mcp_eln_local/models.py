"""Pydantic models, validators, row mappers, and cursor helpers for mcp-eln-local.

This module is the canonical source of the wire shapes; routes import from
here and tests / agent-claw builtins consume the JSON-schema export.

Split from main.py during PR-7 (Python God-file split).
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel, Field, field_validator

from services.mcp_tools.common.payload_caps import cap_jsonb


# --------------------------------------------------------------------------
# Validation regexes
# --------------------------------------------------------------------------
_ID_RE = re.compile(r"^[A-Za-z0-9_\-\.:]+$")
_PROJECT_CODE_RE = re.compile(r"^[A-Za-z0-9_\-\.]+$")
_FAMILY_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _validate_id(value: str, field_name: str) -> str:
    if not _ID_RE.match(value):
        raise ValueError(
            f"{field_name} must match {_ID_RE.pattern!r} "
            f"(got {value!r})"
        )
    return value


def _parse_iso(value: str | None, field_name: str) -> datetime | None:
    if value is None:
        return None
    try:
        # fromisoformat handles "2024-01-02T03:04:05+00:00" and similar.
        # Accept trailing Z by translating to +00:00.
        s = value.replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be ISO-8601 (got {value!r})") from exc


# --------------------------------------------------------------------------
# Domain models
# --------------------------------------------------------------------------
class AuditEntry(BaseModel):
    actor_email: str | None = None
    action: str
    field_path: str | None = None
    occurred_at: datetime
    reason: str | None = None


class Attachment(BaseModel):
    id: str
    filename: str
    mime_type: str | None = None
    size_bytes: int | None = None
    description: str | None = None
    uri: str | None = None
    created_at: datetime


class ElnEntry(BaseModel):
    id: str
    notebook_id: str
    project_id: str
    project_code: str | None = None
    reaction_id: str | None = None
    schema_kind: str
    title: str
    author_email: str | None = None
    signed_by: str | None = None
    status: str
    entry_shape: str
    data_quality_tier: str
    fields_jsonb: dict[str, Any] = Field(default_factory=dict)
    freetext: str | None = None
    freetext_length_chars: int = 0
    created_at: datetime
    modified_at: datetime
    signed_at: datetime | None = None
    citation_uri: str
    valid_until: datetime
    attachments: list[Attachment] = Field(default_factory=list)
    audit_summary: list[AuditEntry] = Field(default_factory=list)


class CanonicalReaction(BaseModel):
    reaction_id: str
    canonical_smiles_rxn: str
    family: str
    project_id: str
    project_code: str | None = None
    step_number: int | None = None
    ofat_count: int
    mean_yield: float | None = None
    last_activity_at: datetime | None = None
    citation_uri: str
    valid_until: datetime


class CanonicalReactionDetail(CanonicalReaction):
    ofat_children: list[ElnEntry] = Field(default_factory=list)


class Result(BaseModel):
    id: str
    method_id: str | None = None
    metric: str
    value_num: float | None = None
    value_text: str | None = None
    unit: str | None = None
    measured_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class Sample(BaseModel):
    id: str
    entry_id: str
    sample_code: str
    compound_id: str | None = None
    amount_mg: float | None = None
    purity_pct: float | None = None
    notes: str | None = None
    created_at: datetime
    citation_uri: str
    valid_until: datetime
    results: list[Result] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Request / response models
# --------------------------------------------------------------------------
class ExperimentsQueryIn(BaseModel):
    project_code: str = Field(min_length=1, max_length=64)
    schema_kind: str | None = Field(default=None, max_length=64)
    reaction_id: str | None = Field(default=None, max_length=128)
    since: str | None = Field(
        default=None, description="ISO-8601 cutoff on modified_at."
    )
    entry_shape: str | None = None
    data_quality_tier: str | None = None
    limit: int = Field(default=50, ge=1, le=200)
    cursor: str | None = Field(
        default=None,
        max_length=1024,
        description=(
            "Opaque cursor returned by the previous page. Format: "
            "'<modified_at_iso>|<id>'."
        ),
    )

    @field_validator("project_code")
    @classmethod
    def _check_project_code(cls, v: str) -> str:
        if not _PROJECT_CODE_RE.match(v):
            raise ValueError(
                f"project_code must match {_PROJECT_CODE_RE.pattern!r}"
            )
        return v

    @field_validator("reaction_id")
    @classmethod
    def _check_reaction_id(cls, v: str | None) -> str | None:
        if v is None:
            return v
        return _validate_id(v, "reaction_id")

    @field_validator("entry_shape")
    @classmethod
    def _check_entry_shape(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if v not in ("mixed", "pure-structured", "pure-freetext"):
            raise ValueError("entry_shape must be one of mixed/pure-structured/pure-freetext")
        return v

    @field_validator("data_quality_tier")
    @classmethod
    def _check_dqt(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if v not in ("clean", "partial", "noisy", "failed"):
            raise ValueError("data_quality_tier must be one of clean/partial/noisy/failed")
        return v

    @field_validator("schema_kind")
    @classmethod
    def _check_schema_kind(cls, v: str | None) -> str | None:
        if v is None:
            return v
        return _validate_id(v, "schema_kind")


class ExperimentsQueryOut(BaseModel):
    items: list[ElnEntry]
    next_cursor: str | None = None


class ExperimentsFetchIn(BaseModel):
    entry_id: str = Field(min_length=1, max_length=128)

    @field_validator("entry_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "entry_id")


class ReactionsQueryIn(BaseModel):
    family: str | None = Field(default=None, max_length=64)
    project_code: str | None = Field(default=None, max_length=64)
    step_number: int | None = Field(default=None, ge=0, le=100)
    min_ofat_count: int | None = Field(default=None, ge=0, le=10_000)
    limit: int = Field(default=50, ge=1, le=200)

    @field_validator("project_code")
    @classmethod
    def _check_pc(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _PROJECT_CODE_RE.match(v):
            raise ValueError(
                f"project_code must match {_PROJECT_CODE_RE.pattern!r}"
            )
        return v

    @field_validator("family")
    @classmethod
    def _check_family(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _FAMILY_RE.match(v):
            raise ValueError(f"family must match {_FAMILY_RE.pattern!r}")
        return v


class ReactionsQueryOut(BaseModel):
    items: list[CanonicalReaction]


class ReactionsFetchIn(BaseModel):
    reaction_id: str = Field(min_length=1, max_length=128)
    top_n_ofat: int = Field(default=10, ge=0, le=200)

    @field_validator("reaction_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "reaction_id")


class SamplesFetchIn(BaseModel):
    sample_id: str = Field(min_length=1, max_length=128)

    @field_validator("sample_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "sample_id")


class AttachmentsMetadataIn(BaseModel):
    entry_id: str = Field(min_length=1, max_length=128)

    @field_validator("entry_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "entry_id")


class AttachmentsMetadataOut(BaseModel):
    entry_id: str
    attachments: list[Attachment]


class SamplesByEntryIn(BaseModel):
    entry_id: str = Field(min_length=1, max_length=128)

    @field_validator("entry_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "entry_id")


class SamplesByEntryOut(BaseModel):
    entry_id: str
    samples: list[Sample]


# --------------------------------------------------------------------------
# Citation URI helpers
# --------------------------------------------------------------------------
def entry_citation_uri(entry_id: str) -> str:
    return f"local-mock-eln://eln/entry/{entry_id}"


def reaction_citation_uri(reaction_id: str) -> str:
    return f"local-mock-eln://eln/reaction/{reaction_id}"


def sample_citation_uri(sample_id: str) -> str:
    return f"local-mock-eln://eln/sample/{sample_id}"


# --------------------------------------------------------------------------
# Row mappers (psycopg DictRow → Pydantic model)
# --------------------------------------------------------------------------
def valid_until_now(valid_until_days: int) -> datetime:
    return datetime.now(timezone.utc) + timedelta(days=valid_until_days)


def row_to_entry(row: dict[str, Any], valid_until_days: int) -> ElnEntry:
    eid = str(row["id"])
    return ElnEntry(
        id=eid,
        notebook_id=str(row["notebook_id"]),
        project_id=str(row["project_id"]),
        project_code=row.get("project_code"),
        reaction_id=str(row["reaction_id"]) if row.get("reaction_id") else None,
        schema_kind=row["schema_kind"],
        title=row["title"],
        author_email=row.get("author_email"),
        signed_by=row.get("signed_by"),
        status=row["status"],
        entry_shape=row["entry_shape"],
        data_quality_tier=row["data_quality_tier"],
        fields_jsonb=cap_jsonb(
            row.get("fields_jsonb") or {}, field_name="fields_jsonb"
        ),
        freetext=row.get("freetext"),
        freetext_length_chars=row.get("freetext_length_chars") or 0,
        created_at=row["created_at"],
        modified_at=row["modified_at"],
        signed_at=row.get("signed_at"),
        citation_uri=entry_citation_uri(eid),
        valid_until=valid_until_now(valid_until_days),
        attachments=[],
        audit_summary=[],
    )


def row_to_canonical_reaction(
    row: dict[str, Any], valid_until_days: int
) -> CanonicalReaction:
    rid = str(row["reaction_id"])
    mean_yield_raw = row.get("mean_yield")
    return CanonicalReaction(
        reaction_id=rid,
        canonical_smiles_rxn=row["canonical_smiles_rxn"],
        family=row["family"],
        project_id=str(row["project_id"]),
        project_code=row.get("project_code"),
        step_number=row.get("step_number"),
        ofat_count=int(row.get("ofat_count") or 0),
        mean_yield=float(mean_yield_raw) if mean_yield_raw is not None else None,
        last_activity_at=row.get("last_activity_at"),
        citation_uri=reaction_citation_uri(rid),
        valid_until=valid_until_now(valid_until_days),
    )


def row_to_attachment(row: dict[str, Any]) -> Attachment:
    return Attachment(
        id=str(row["id"]),
        filename=row["filename"],
        mime_type=row.get("mime_type"),
        size_bytes=row.get("size_bytes"),
        description=row.get("description"),
        uri=row.get("uri"),
        created_at=row["created_at"],
    )


def row_to_audit(row: dict[str, Any]) -> AuditEntry:
    return AuditEntry(
        actor_email=row.get("actor_email"),
        action=row["action"],
        field_path=row.get("field_path"),
        occurred_at=row["occurred_at"],
        reason=row.get("reason"),
    )


def row_to_result(row: dict[str, Any]) -> Result:
    return Result(
        id=str(row["id"]),
        method_id=str(row["method_id"]) if row.get("method_id") else None,
        metric=row["metric"],
        value_num=float(row["value_num"]) if row.get("value_num") is not None else None,
        value_text=row.get("value_text"),
        unit=row.get("unit"),
        measured_at=row.get("measured_at"),
        metadata=cap_jsonb(row.get("metadata") or {}, field_name="results.metadata"),
    )


def row_to_sample(row: dict[str, Any], valid_until_days: int) -> Sample:
    sid = str(row["id"])
    return Sample(
        id=sid,
        entry_id=str(row["entry_id"]),
        sample_code=row["sample_code"],
        compound_id=str(row["compound_id"]) if row.get("compound_id") else None,
        amount_mg=float(row["amount_mg"]) if row.get("amount_mg") is not None else None,
        purity_pct=float(row["purity_pct"]) if row.get("purity_pct") is not None else None,
        notes=row.get("notes"),
        created_at=row["created_at"],
        citation_uri=sample_citation_uri(sid),
        valid_until=valid_until_now(valid_until_days),
        results=[],
    )


# --------------------------------------------------------------------------
# Cursor codec
# --------------------------------------------------------------------------
def encode_cursor(modified_at: datetime, entry_id: str) -> str:
    return f"{modified_at.isoformat()}|{entry_id}"


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    parts = cursor.split("|", 1)
    if len(parts) != 2:
        raise ValueError("cursor must be '<iso-timestamp>|<id>'")
    ts = _parse_iso(parts[0], "cursor")
    if ts is None:
        raise ValueError("cursor timestamp could not be parsed")
    eid = parts[1]
    if not _ID_RE.match(eid):
        raise ValueError("cursor id segment is invalid")
    return ts, eid
