"""Pydantic schemas for ELN JSON imports.

MVP shape: a flat JSON document produced as a Dotmatics export. The real
live-API adapter will populate the same shape via an adapter module so the
importer doesn't change.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ELNReagent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    smiles: str | None = None
    role: str = Field(pattern=r"^(reagent|product|catalyst|solvent|base|acid|other)$")
    amount_value: float | None = None
    amount_unit: str | None = None
    equiv: float | None = None


class ELNReaction(BaseModel):
    """A single reaction attempt inside an experiment."""

    model_config = ConfigDict(extra="forbid")
    rxn_smiles: str | None = None
    rxn_smarts: str | None = None
    rxno_class: str | None = None
    reagents: list[ELNReagent] = Field(default_factory=list)


class ELNAnalyticalResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method_class: str
    instrument: str | None = None
    value: float | None = None
    unit: str | None = None
    raw_file_pointer: str | None = None
    quality_flag: str | None = None


class ELNExperiment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    eln_entry_id: str
    project_internal_id: str
    step_index: int
    step_name: str
    target_compound_inchikey: str | None = None
    date_performed: date | None = None
    operator_entra_id: str | None = None
    procedure_text: str | None = None
    observations: str | None = None
    tabular_data: dict[str, Any] = Field(default_factory=dict)
    yield_pct: float | None = None
    scale_mg: float | None = None
    outcome_status: str | None = None
    raw_source_file_path: str | None = None

    reactions: list[ELNReaction] = Field(default_factory=list)
    analytical_results: list[ELNAnalyticalResult] = Field(default_factory=list)


class ELNImportDocument(BaseModel):
    """Top-level payload: a batch of experiments belonging to one or more projects."""

    model_config = ConfigDict(extra="forbid")

    source: str = Field(default="dotmatics_json_export")
    exported_at: str | None = None
    experiments: list[ELNExperiment]
