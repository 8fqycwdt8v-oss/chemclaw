"""Chromatography-aware BoFire Domain builder.

Translates a chromatographer-friendly request — gradient scheme, column
choice list with Tanaka descriptors, B-solvent / additive choices,
flow / temperature bounds, objective mode — into a canonical BoFire
Domain. Pure function: no I/O, no DB, no BoFire strategy fitting.

Gradient schemes
----------------
  - linear          4 continuous params: pctB_init, t_grad_min, pctB_final,
                    t_hold_final_min
  - hold_ramp_hold  5 continuous params (default): + t_hold_init_min
  - multi_segment   4 + 2·N params: pctB_init, then for each of N breakpoints
                    t_break{i}_min + pctB_break{i}, then t_hold_final_min.
                    The Nth breakpoint's %B is the final %B. Monotonicity of
                    both the breakpoint times and the %B trace is enforced by
                    chained LinearInequalityConstraints.

Eluent modes
------------
  - binary   (default) — A = water, B = a chosen organic; b_solvent is a
              CategoricalInput over the supplied choices.
  - ternary  — A = water, B-channel = a MeCN/MeOH mix parameterised by a
              continuous b_meoh_fraction ∈ [0, 1] (the rest is MeCN);
              the b_solvent categorical is dropped. (A literal 3-component
              mixture-constraint form for co-solvent doping is a further
              extension — see BACKLOG.)

Constraints
-----------
  - linear / hold_ramp_hold: pctB_init ≤ pctB_final (one
    LinearInequalityConstraint; BoFire encodes Σ cᵢxᵢ ≤ rhs, so
    coefficients [+1, −1] on [pctB_init, pctB_final], rhs 0).
  - multi_segment: chained  t_break₁ ≤ t_break₂ ≤ … ≤ t_break_N  and
    pctB_init ≤ pctB_break₁ ≤ … ≤ pctB_break_N.

Outputs (objective_mode)
------------------------
  - "single"           one ContinuousOutput("crf_total", Maximize)
  - "pareto"           three: min_resolution (Max), runtime_min (Min),
                        solvent_pmi_g (Min)
  - "close_to_target"  raises NotImplementedError (deferred).
"""
from __future__ import annotations

from enum import StrEnum
from itertools import pairwise
from typing import Any, Sequence


class GradientScheme(StrEnum):
    LINEAR = "linear"
    HOLD_RAMP_HOLD = "hold_ramp_hold"
    MULTI_SEGMENT = "multi_segment"


class EluentMode(StrEnum):
    BINARY = "binary"
    TERNARY = "ternary"


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
DEFAULT_PCTB_INIT_BOUNDS: tuple[float, float] = (2.0, 50.0)
DEFAULT_PCTB_BREAK_BOUNDS: tuple[float, float] = (2.0, 100.0)
DEFAULT_PCTB_FINAL_BOUNDS: tuple[float, float] = (50.0, 100.0)
DEFAULT_T_GRAD_BOUNDS_MIN: tuple[float, float] = (2.0, 30.0)
DEFAULT_T_BREAK_BOUNDS_MIN: tuple[float, float] = (0.5, 30.0)
DEFAULT_T_HOLD_INIT_BOUNDS_MIN: tuple[float, float] = (0.0, 5.0)
DEFAULT_T_HOLD_FINAL_BOUNDS_MIN: tuple[float, float] = (0.0, 3.0)
DEFAULT_B_MEOH_FRACTION_BOUNDS: tuple[float, float] = (0.0, 1.0)

MAX_SEGMENTS = 5


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
    eluent_mode: EluentMode = EluentMode.BINARY,
    n_segments: int = 3,
) -> Any:
    """Construct and return a BoFire Domain. Pure function.

    Raises ValueError on infeasible inputs (empty categorical choices,
    descriptor-shape mismatch, inverted bounds, n_segments out of range).
    Raises NotImplementedError for the deferred close_to_target objective.
    """
    _validate_inputs(
        column_choices=column_choices,
        column_descriptors=column_descriptors,
        b_solvent_choices=b_solvent_choices,
        additive_choices=additive_choices,
        flow_bounds_mLmin=flow_bounds_mLmin,
        T_bounds_C=T_bounds_C,
        eluent_mode=eluent_mode,
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
    # vary (e.g. only descriptor-clone columns) fall back to plain
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

    # ── eluent: B-solvent (binary) or organic-mix fraction (ternary) ────
    if eluent_mode == EluentMode.TERNARY:
        inputs.append(ContinuousInput(
            key="b_meoh_fraction", bounds=DEFAULT_B_MEOH_FRACTION_BOUNDS,
        ))
    else:
        inputs.append(CategoricalInput(key="b_solvent", categories=list(b_solvent_choices)))
    inputs.append(CategoricalInput(key="additive", categories=list(additive_choices)))

    # ── flow + column temperature ───────────────────────────────────────
    inputs.append(ContinuousInput(key="flow_mLmin", bounds=tuple(flow_bounds_mLmin)))
    inputs.append(ContinuousInput(key="T_col_C", bounds=tuple(T_bounds_C)))

    # ── monotonicity constraints ────────────────────────────────────────
    constraints: list[Any] = _gradient_constraints(
        gradient_scheme, LinearInequalityConstraint, n_segments,
    )

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
            f"objective_mode {objective_mode!r} not implemented"
        )

    return Domain(
        inputs=Inputs(features=inputs),
        outputs=Outputs(features=outputs),
        constraints=Constraints(constraints=constraints),
    )


def _break_keys(n_segments: int) -> list[tuple[str, str]]:
    """Return [(t_break_i, pctB_break_i), ...] for i in 1..n_segments."""
    return [(f"t_break{i}_min", f"pctB_break{i}") for i in range(1, n_segments + 1)]


def _gradient_inputs(
    scheme: GradientScheme,
    ContinuousInput: Any,
    n_segments: int,
) -> list[Any]:
    """Return the list of ContinuousInput features for the chosen scheme."""
    if scheme == GradientScheme.LINEAR:
        return [
            ContinuousInput(key="pctB_init",        bounds=DEFAULT_PCTB_INIT_BOUNDS),
            ContinuousInput(key="t_grad_min",       bounds=DEFAULT_T_GRAD_BOUNDS_MIN),
            ContinuousInput(key="pctB_final",       bounds=DEFAULT_PCTB_FINAL_BOUNDS),
            ContinuousInput(key="t_hold_final_min", bounds=DEFAULT_T_HOLD_FINAL_BOUNDS_MIN),
        ]
    if scheme == GradientScheme.HOLD_RAMP_HOLD:
        return [
            ContinuousInput(key="t_hold_init_min",  bounds=DEFAULT_T_HOLD_INIT_BOUNDS_MIN),
            ContinuousInput(key="pctB_init",        bounds=DEFAULT_PCTB_INIT_BOUNDS),
            ContinuousInput(key="t_grad_min",       bounds=DEFAULT_T_GRAD_BOUNDS_MIN),
            ContinuousInput(key="pctB_final",       bounds=DEFAULT_PCTB_FINAL_BOUNDS),
            ContinuousInput(key="t_hold_final_min", bounds=DEFAULT_T_HOLD_FINAL_BOUNDS_MIN),
        ]
    if scheme == GradientScheme.MULTI_SEGMENT:
        feats: list[Any] = [
            ContinuousInput(key="pctB_init", bounds=DEFAULT_PCTB_INIT_BOUNDS),
        ]
        for t_key, p_key in _break_keys(n_segments):
            feats.append(ContinuousInput(key=t_key, bounds=DEFAULT_T_BREAK_BOUNDS_MIN))
            feats.append(ContinuousInput(key=p_key, bounds=DEFAULT_PCTB_BREAK_BOUNDS))
        feats.append(
            ContinuousInput(key="t_hold_final_min", bounds=DEFAULT_T_HOLD_FINAL_BOUNDS_MIN)
        )
        return feats
    raise ValueError(f"unknown gradient_scheme: {scheme!r}")


def _gradient_constraints(
    scheme: GradientScheme,
    LinearInequalityConstraint: Any,
    n_segments: int,
) -> list[Any]:
    """Monotonicity constraints for the chosen scheme.

    BoFire LinearInequalityConstraint encodes Σ cᵢxᵢ ≤ rhs. To enforce
    a ≤ b we write a − b ≤ 0, i.e. coefficients [+1, −1] over [a, b].
    """
    if scheme in (GradientScheme.LINEAR, GradientScheme.HOLD_RAMP_HOLD):
        return [
            LinearInequalityConstraint(
                features=["pctB_init", "pctB_final"],
                coefficients=[1.0, -1.0],
                rhs=0.0,
            ),
        ]
    if scheme == GradientScheme.MULTI_SEGMENT:
        out: list[Any] = []
        breaks = _break_keys(n_segments)
        # time monotonicity: t_break1 ≤ t_break2 ≤ … (bounds enforce ≥ 0)
        for (t_prev, _), (t_next, _) in pairwise(breaks):
            out.append(LinearInequalityConstraint(
                features=[t_prev, t_next], coefficients=[1.0, -1.0], rhs=0.0,
            ))
        # %B monotonicity: pctB_init ≤ pctB_break1 ≤ pctB_break2 ≤ …
        pctb_chain = ["pctB_init"] + [p for _, p in breaks]
        for a, b in pairwise(pctb_chain):
            out.append(LinearInequalityConstraint(
                features=[a, b], coefficients=[1.0, -1.0], rhs=0.0,
            ))
        return out
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

    Returns (kept_names, [[row1_kept], …]). `kept_names` may be empty if
    every descriptor is constant (e.g. descriptor-clone columns), in which
    case the caller should fall back to plain CategoricalInput.
    """
    if not values:
        return list(names), []
    keep_idx = [j for j in range(len(names)) if len({row[j] for row in values}) > 1]
    return [names[j] for j in keep_idx], [[row[j] for j in keep_idx] for row in values]


def _validate_inputs(
    *,
    column_choices: Sequence[str],
    column_descriptors: Sequence[Sequence[float]],
    b_solvent_choices: Sequence[str],
    additive_choices: Sequence[str],
    flow_bounds_mLmin: tuple[float, float],
    T_bounds_C: tuple[float, float],
    eluent_mode: EluentMode,
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
    # b_solvent_choices only used in binary mode; still require something
    # sensible was passed so a mode flip doesn't surprise the caller.
    if eluent_mode == EluentMode.BINARY and not b_solvent_choices:
        raise ValueError("b_solvent_choices must be non-empty in binary eluent mode")
    if not additive_choices:
        raise ValueError("additive_choices must be non-empty")
    if flow_bounds_mLmin[0] >= flow_bounds_mLmin[1]:
        raise ValueError(f"flow_bounds_mLmin inverted: {flow_bounds_mLmin}")
    if T_bounds_C[0] >= T_bounds_C[1]:
        raise ValueError(f"T_bounds_C inverted: {T_bounds_C}")
    if n_segments < 1 or n_segments > MAX_SEGMENTS:
        raise ValueError(f"n_segments out of range (1..{MAX_SEGMENTS}): {n_segments}")


# ───────────────────────────────────────────────────────────────────────────
# Method materialisation: factor_values dict → executable (time, %B) table.
# Pure function. No BoFire involvement.
# ───────────────────────────────────────────────────────────────────────────

def materialize_gradient_program(
    factor_values: dict[str, Any],
    scheme: GradientScheme,
    n_segments: int = 3,
) -> list[dict[str, float]]:
    """Expand the gradient-shape factors into an explicit (time_min, pctB) table.

    Output: ordered list of {time_min, pctB} rows starting at (0, pctB_init)
    and ending after the final hold. Monotonic in both axes for every
    scheme (assuming the constraints from _gradient_constraints held).
    """
    pctB_init  = float(factor_values["pctB_init"])
    t_hold_end = float(factor_values.get("t_hold_final_min", 0.0))

    if scheme == GradientScheme.LINEAR:
        pctB_final = float(factor_values["pctB_final"])
        t_grad     = float(factor_values["t_grad_min"])
        program = [
            {"time_min": 0.0,                  "pctB": pctB_init},
            {"time_min": t_grad,               "pctB": pctB_final},
            {"time_min": t_grad + t_hold_end,  "pctB": pctB_final},
        ]
    elif scheme == GradientScheme.HOLD_RAMP_HOLD:
        pctB_final  = float(factor_values["pctB_final"])
        t_grad      = float(factor_values["t_grad_min"])
        t_hold_init = float(factor_values.get("t_hold_init_min", 0.0))
        program = [
            {"time_min": 0.0,                                "pctB": pctB_init},
            {"time_min": t_hold_init,                        "pctB": pctB_init},
            {"time_min": t_hold_init + t_grad,               "pctB": pctB_final},
            {"time_min": t_hold_init + t_grad + t_hold_end,  "pctB": pctB_final},
        ]
    elif scheme == GradientScheme.MULTI_SEGMENT:
        program = [{"time_min": 0.0, "pctB": pctB_init}]
        last_t = 0.0
        last_p = pctB_init
        for t_key, p_key in _break_keys(n_segments):
            last_t = float(factor_values[t_key])
            last_p = float(factor_values[p_key])
            program.append({"time_min": last_t, "pctB": last_p})
        program.append({"time_min": last_t + t_hold_end, "pctB": last_p})
    else:
        raise NotImplementedError(f"materialize for scheme {scheme!r} not implemented")

    return [
        {"time_min": round(row["time_min"], 4), "pctB": round(row["pctB"], 3)}
        for row in program
    ]
