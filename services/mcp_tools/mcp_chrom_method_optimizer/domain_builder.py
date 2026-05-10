"""Chromatography-aware BoFire Domain builder.

Translates a chromatographer-friendly request — gradient scheme, column
choice list with Tanaka descriptors, B-solvent / additive choices,
flow / temperature bounds, objective mode — into a canonical BoFire
Domain. Pure function: no I/O, no DB, no BoFire strategy fitting.

Gradient schemes (v1):
  - linear (4 continuous params: pctB_init, t_grad, pctB_final, t_hold_final)
  - hold_ramp_hold (5 continuous params, default)
  - multi_segment (Phase 4) — currently raises NotImplementedError so callers
    can detect the gap.

Constraints:
  - pctB_final >= pctB_init enforced via LinearInequalityConstraint on every
    scheme (BoFire encodes "a*x <= b" so we send coefficients [+1, -1] for
    "pctB_init - pctB_final <= 0").

Outputs (objective_mode):
  - "single"   — one ContinuousOutput("crf_total", MaximizeObjective)
  - "pareto"   — three ContinuousOutputs:
                  min_resolution (max), runtime_min (min), solvent_pmi_g (min)
  - "close_to_target" — Phase 3+; raises NotImplementedError today.
"""
from __future__ import annotations

from enum import StrEnum
from typing import Any, Sequence


class GradientScheme(StrEnum):
    LINEAR = "linear"
    HOLD_RAMP_HOLD = "hold_ramp_hold"
    MULTI_SEGMENT = "multi_segment"


class ObjectiveMode(StrEnum):
    SINGLE = "single"
    PARETO = "pareto"
    CLOSE_TO_TARGET = "close_to_target"


# Tanaka 6-axis descriptor names (must match column_inventory column order
# and the agent-claw query_chrom_columns builtin's projection).
TANAKA_DESCRIPTORS: tuple[str, ...] = (
    "kPB",
    "alphaCH2",
    "alphaT_O",
    "alphaC_P",
    "alphaB_P_pH27",
    "alphaB_P_pH76",
)


# Default safe envelope when caller omits per-factor bounds. Conservative
# numbers chosen to fit the intersection of common UHPLC column specs.
DEFAULT_T_BOUNDS_C: tuple[float, float] = (25.0, 55.0)
DEFAULT_FLOW_BOUNDS_MLMIN: tuple[float, float] = (0.2, 1.0)
DEFAULT_PCTB_RANGE: tuple[float, float] = (2.0, 100.0)


def build_chrom_domain(
    *,
    gradient_scheme: GradientScheme,
    column_choices: Sequence[str],
    column_descriptors: Sequence[Sequence[float]],
    b_solvent_choices: Sequence[str],
    additive_choices: Sequence[str],
    flow_bounds_mLmin: tuple[float, float] = DEFAULT_FLOW_BOUNDS_MLMIN,
    T_bounds_C: tuple[float, float] = DEFAULT_T_BOUNDS_C,
    objective_mode: ObjectiveMode = ObjectiveMode.SINGLE,
    n_segments: int = 3,
) -> Any:
    """Construct and return a BoFire Domain. Pure function.

    Raises ValueError on infeasible inputs (empty categorical choices,
    descriptor-shape mismatch, inverted bounds). Raises NotImplementedError
    for schemes deferred to later phases.
    """
    _validate_inputs(
        gradient_scheme=gradient_scheme,
        column_choices=column_choices,
        column_descriptors=column_descriptors,
        b_solvent_choices=b_solvent_choices,
        additive_choices=additive_choices,
        flow_bounds_mLmin=flow_bounds_mLmin,
        T_bounds_C=T_bounds_C,
        objective_mode=objective_mode,
        n_segments=n_segments,
    )

    # Local imports — bofire is a heavy dep, keep importable when missing
    # so the test process can mock it.
    from bofire.data_models.constraints.api import LinearInequalityConstraint
    from bofire.data_models.domain.api import (
        Constraints, Domain, Inputs, Outputs,
    )
    from bofire.data_models.features.api import (
        CategoricalDescriptorInput, CategoricalInput, ContinuousInput,
        ContinuousOutput,
    )
    from bofire.data_models.objectives.api import (
        MaximizeObjective, MinimizeObjective,
    )

    inputs: list[Any] = []

    # ── gradient parameters ─────────────────────────────────────────────
    inputs.extend(_gradient_inputs(gradient_scheme, ContinuousInput, n_segments))

    # ── column ──────────────────────────────────────────────────────────
    # BoFire's CategoricalDescriptorInput rejects descriptors with no
    # variation across categories (a constant column adds no information
    # to the GP). Drop constants before passing in; if NO descriptors
    # vary (e.g. only one column was supplied) fall back to plain
    # CategoricalInput.
    kept_names, kept_values = _drop_constant_descriptors(
        list(TANAKA_DESCRIPTORS), [list(row) for row in column_descriptors],
    )
    if kept_names:
        inputs.append(CategoricalDescriptorInput(
            key="column",
            categories=list(column_choices),
            descriptors=kept_names,
            values=kept_values,
        ))
    else:
        inputs.append(CategoricalInput(
            key="column",
            categories=list(column_choices),
        ))

    # ── B-solvent + additive (plain CategoricalInput, low cardinality) ──
    inputs.append(CategoricalInput(key="b_solvent", categories=list(b_solvent_choices)))
    inputs.append(CategoricalInput(key="additive", categories=list(additive_choices)))

    # ── flow + column temperature ───────────────────────────────────────
    inputs.append(ContinuousInput(key="flow_mLmin", bounds=tuple(flow_bounds_mLmin)))
    inputs.append(ContinuousInput(key="T_col_C", bounds=tuple(T_bounds_C)))

    # ── monotonicity constraint: pctB_final >= pctB_init ────────────────
    # BoFire LinearInequalityConstraint encodes  Σ c_i x_i <= rhs.
    # We want pctB_init - pctB_final <= 0, hence coefficients [+1, -1].
    constraints: list[Any] = [
        LinearInequalityConstraint(
            features=["pctB_init", "pctB_final"],
            coefficients=[1.0, -1.0],
            rhs=0.0,
        ),
    ]

    # ── outputs ─────────────────────────────────────────────────────────
    outputs: list[Any]
    if objective_mode == ObjectiveMode.SINGLE:
        outputs = [
            ContinuousOutput(key="crf_total", objective=MaximizeObjective(w=1.0)),
        ]
    elif objective_mode == ObjectiveMode.PARETO:
        outputs = [
            ContinuousOutput(key="min_resolution", objective=MaximizeObjective(w=1.0)),
            ContinuousOutput(key="runtime_min",    objective=MinimizeObjective(w=1.0)),
            ContinuousOutput(key="solvent_pmi_g",  objective=MinimizeObjective(w=1.0)),
        ]
    else:
        raise NotImplementedError(
            f"objective_mode {objective_mode!r} not implemented in Phase 1"
        )

    return Domain(
        inputs=Inputs(features=inputs),
        outputs=Outputs(features=outputs),
        constraints=Constraints(constraints=constraints),
    )


def _gradient_inputs(
    scheme: GradientScheme,
    ContinuousInput: Any,
    n_segments: int,
) -> list[Any]:
    """Return the list of ContinuousInput features for the chosen scheme."""
    if scheme == GradientScheme.LINEAR:
        # 4 params: gradient time, initial / final %B, optional final hold.
        return [
            ContinuousInput(key="pctB_init",        bounds=(2.0, 50.0)),
            ContinuousInput(key="t_grad_min",       bounds=(2.0, 30.0)),
            ContinuousInput(key="pctB_final",       bounds=(50.0, 100.0)),
            ContinuousInput(key="t_hold_final_min", bounds=(0.0, 3.0)),
        ]
    if scheme == GradientScheme.HOLD_RAMP_HOLD:
        # 5 params: initial hold + hold_ramp + final hold.
        return [
            ContinuousInput(key="t_hold_init_min",  bounds=(0.0, 5.0)),
            ContinuousInput(key="pctB_init",        bounds=(2.0, 50.0)),
            ContinuousInput(key="t_grad_min",       bounds=(2.0, 30.0)),
            ContinuousInput(key="pctB_final",       bounds=(50.0, 100.0)),
            ContinuousInput(key="t_hold_final_min", bounds=(0.0, 3.0)),
        ]
    if scheme == GradientScheme.MULTI_SEGMENT:
        raise NotImplementedError(
            "multi_segment gradient scheme is Phase 4; use linear or "
            "hold_ramp_hold in Phase 1."
        )
    raise ValueError(f"unknown gradient_scheme: {scheme!r}")


def _drop_constant_descriptors(
    names: list[str],
    values: list[list[float]],
) -> tuple[list[str], list[list[float]]]:
    """Drop descriptor columns whose values are identical across all rows.

    BoFire's `CategoricalDescriptorInput` requires every descriptor to
    actually distinguish at least two categories — a constant column
    raises pydantic `ValidationError("No variation for descriptor X")`.
    Real Tanaka tables for closely-matched columns frequently show
    identical values on one or two of the six axes; we drop those silently
    so a campaign with such a column subset still builds.

    Returns (kept_names, [[row1_kept], [row2_kept], ...]). `kept_names`
    may be empty if every descriptor is constant (e.g. a single column),
    in which case the caller should fall back to plain CategoricalInput.
    """
    if not values:
        return list(names), []
    n_descriptors = len(names)
    keep_idx: list[int] = []
    for j in range(n_descriptors):
        col_vals = {row[j] for row in values}
        if len(col_vals) > 1:
            keep_idx.append(j)
    kept_names = [names[j] for j in keep_idx]
    kept_values = [[row[j] for j in keep_idx] for row in values]
    return kept_names, kept_values


def _validate_inputs(
    *,
    gradient_scheme: GradientScheme,
    column_choices: Sequence[str],
    column_descriptors: Sequence[Sequence[float]],
    b_solvent_choices: Sequence[str],
    additive_choices: Sequence[str],
    flow_bounds_mLmin: tuple[float, float],
    T_bounds_C: tuple[float, float],
    objective_mode: ObjectiveMode,
    n_segments: int,
) -> None:
    if not column_choices:
        raise ValueError("column_choices must be non-empty")
    if len(column_choices) != len(column_descriptors):
        raise ValueError(
            f"column_descriptors length ({len(column_descriptors)}) must match "
            f"column_choices length ({len(column_choices)})"
        )
    for i, row in enumerate(column_descriptors):
        if len(row) != len(TANAKA_DESCRIPTORS):
            raise ValueError(
                f"column_descriptors[{i}] has {len(row)} values; expected "
                f"{len(TANAKA_DESCRIPTORS)} (Tanaka 6-axis)"
            )
    if not b_solvent_choices:
        raise ValueError("b_solvent_choices must be non-empty")
    if not additive_choices:
        raise ValueError("additive_choices must be non-empty")
    if flow_bounds_mLmin[0] >= flow_bounds_mLmin[1]:
        raise ValueError(f"flow_bounds_mLmin inverted: {flow_bounds_mLmin}")
    if T_bounds_C[0] >= T_bounds_C[1]:
        raise ValueError(f"T_bounds_C inverted: {T_bounds_C}")
    if n_segments < 1 or n_segments > 5:
        raise ValueError(f"n_segments out of range: {n_segments}")
    # objective_mode passes through to build_chrom_domain which raises
    # NotImplementedError for the deferred CLOSE_TO_TARGET branch.
    _ = objective_mode
    _ = gradient_scheme


# ───────────────────────────────────────────────────────────────────────────
# Method materialisation: factor_values dict → executable method JSON.
# Pure function. No BoFire involvement.
# ───────────────────────────────────────────────────────────────────────────

def materialize_gradient_program(
    factor_values: dict[str, Any],
    scheme: GradientScheme,
) -> list[dict[str, float]]:
    """Expand the gradient-shape factors into an explicit (time_min, pctB) table.

    Output: ordered list of {time_min, pctB} rows starting at (0, pctB_init)
    and ending at the final hold. Monotonic in both axes for HOLD_RAMP_HOLD
    and LINEAR schemes (callers should validate when this is not the case).
    """
    pctB_init  = float(factor_values["pctB_init"])
    pctB_final = float(factor_values["pctB_final"])
    t_grad     = float(factor_values["t_grad_min"])
    t_hold_end = float(factor_values.get("t_hold_final_min", 0.0))

    if scheme == GradientScheme.LINEAR:
        program = [
            {"time_min": 0.0,                  "pctB": pctB_init},
            {"time_min": t_grad,               "pctB": pctB_final},
            {"time_min": t_grad + t_hold_end,  "pctB": pctB_final},
        ]
    elif scheme == GradientScheme.HOLD_RAMP_HOLD:
        t_hold_init = float(factor_values.get("t_hold_init_min", 0.0))
        program = [
            {"time_min": 0.0,                                "pctB": pctB_init},
            {"time_min": t_hold_init,                        "pctB": pctB_init},
            {"time_min": t_hold_init + t_grad,               "pctB": pctB_final},
            {"time_min": t_hold_init + t_grad + t_hold_end,  "pctB": pctB_final},
        ]
    else:
        raise NotImplementedError(f"materialize for scheme {scheme!r} not implemented")

    return [
        {"time_min": round(row["time_min"], 4), "pctB": round(row["pctB"], 3)}
        for row in program
    ]
