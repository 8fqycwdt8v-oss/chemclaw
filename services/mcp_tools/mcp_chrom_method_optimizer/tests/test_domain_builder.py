"""Tests for the chromatography Domain builder.

Pure-function tests: no FastAPI, no HTTP. Exercises gradient schemes,
descriptor-shape validation, monotonicity constraint, objective modes,
and gradient materialisation.
"""
from __future__ import annotations

import pytest

from services.mcp_tools.mcp_chrom_method_optimizer import domain_builder as _db


# Minimal viable inputs reused across tests
MIN_COLS = ["BEH-C18", "Kinetex-EVO"]
MIN_DESC = [
    [3.30, 1.480, 1.500, 0.420, 0.190, 0.290],   # BEH-C18
    [3.20, 1.480, 1.510, 0.460, 0.140, 0.310],   # Kinetex-EVO
]
MIN_BSOL = ["MeCN", "MeOH"]
MIN_ADD  = ["FA_0.1pct", "TFA_0.1pct"]


def test_hold_ramp_hold_domain_has_expected_inputs():
    domain = _db.build_chrom_domain(
        gradient_scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
        column_choices=MIN_COLS,
        column_descriptors=MIN_DESC,
        b_solvent_choices=MIN_BSOL,
        additive_choices=MIN_ADD,
    )
    keys = {f.key for f in domain.inputs.features}
    # 5 gradient continuous + column descriptor + b_solvent + additive
    # + flow + T_col_C
    assert keys == {
        "t_hold_init_min", "pctB_init", "t_grad_min", "pctB_final", "t_hold_final_min",
        "column", "b_solvent", "additive", "flow_mLmin", "T_col_C",
    }


def test_linear_domain_has_four_gradient_inputs():
    domain = _db.build_chrom_domain(
        gradient_scheme=_db.GradientScheme.LINEAR,
        column_choices=MIN_COLS,
        column_descriptors=MIN_DESC,
        b_solvent_choices=MIN_BSOL,
        additive_choices=MIN_ADD,
    )
    keys = {f.key for f in domain.inputs.features}
    assert "t_hold_init_min" not in keys
    assert {"pctB_init", "t_grad_min", "pctB_final", "t_hold_final_min"} <= keys


def test_monotonicity_constraint_present():
    domain = _db.build_chrom_domain(
        gradient_scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
        column_choices=MIN_COLS,
        column_descriptors=MIN_DESC,
        b_solvent_choices=MIN_BSOL,
        additive_choices=MIN_ADD,
    )
    constraints = domain.constraints.constraints
    assert len(constraints) == 1
    c = constraints[0]
    # pctB_init - pctB_final <= 0  ⇒ coefficients [+1, -1] over [pctB_init, pctB_final]
    assert set(c.features) == {"pctB_init", "pctB_final"}
    coeffs_by_feat = dict(zip(c.features, c.coefficients))
    assert coeffs_by_feat["pctB_init"] == pytest.approx(1.0)
    assert coeffs_by_feat["pctB_final"] == pytest.approx(-1.0)


def test_descriptor_input_carries_tanaka_values():
    domain = _db.build_chrom_domain(
        gradient_scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
        column_choices=MIN_COLS,
        column_descriptors=MIN_DESC,
        b_solvent_choices=MIN_BSOL,
        additive_choices=MIN_ADD,
    )
    column_feature = next(f for f in domain.inputs.features if f.key == "column")
    assert column_feature.categories == MIN_COLS
    assert tuple(column_feature.descriptors) == _db.TANAKA_DESCRIPTORS
    # Round-trip via the values list of lists
    assert column_feature.values == MIN_DESC


def test_pareto_domain_has_three_outputs():
    domain = _db.build_chrom_domain(
        gradient_scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
        column_choices=MIN_COLS,
        column_descriptors=MIN_DESC,
        b_solvent_choices=MIN_BSOL,
        additive_choices=MIN_ADD,
        objective_mode=_db.ObjectiveMode.PARETO,
    )
    out_keys = [f.key for f in domain.outputs.features]
    assert out_keys == ["min_resolution", "runtime_min", "solvent_pmi_g"]


def test_single_objective_has_crf_total():
    domain = _db.build_chrom_domain(
        gradient_scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
        column_choices=MIN_COLS,
        column_descriptors=MIN_DESC,
        b_solvent_choices=MIN_BSOL,
        additive_choices=MIN_ADD,
        objective_mode=_db.ObjectiveMode.SINGLE,
    )
    out_keys = [f.key for f in domain.outputs.features]
    assert out_keys == ["crf_total"]


def test_descriptor_shape_mismatch_raises():
    with pytest.raises(ValueError, match="Tanaka 6-axis"):
        _db.build_chrom_domain(
            gradient_scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
            column_choices=["A"],
            column_descriptors=[[1.0, 2.0]],   # only 2 of 6 descriptors
            b_solvent_choices=MIN_BSOL,
            additive_choices=MIN_ADD,
        )


def test_empty_column_choices_raises():
    with pytest.raises(ValueError, match="column_choices"):
        _db.build_chrom_domain(
            gradient_scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
            column_choices=[],
            column_descriptors=[],
            b_solvent_choices=MIN_BSOL,
            additive_choices=MIN_ADD,
        )


def test_inverted_flow_bounds_raises():
    with pytest.raises(ValueError, match="flow_bounds_mLmin"):
        _db.build_chrom_domain(
            gradient_scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
            column_choices=MIN_COLS,
            column_descriptors=MIN_DESC,
            b_solvent_choices=MIN_BSOL,
            additive_choices=MIN_ADD,
            flow_bounds_mLmin=(1.0, 0.5),
        )


def test_multi_segment_scheme_not_implemented_yet():
    with pytest.raises(NotImplementedError, match="Phase 4"):
        _db.build_chrom_domain(
            gradient_scheme=_db.GradientScheme.MULTI_SEGMENT,
            column_choices=MIN_COLS,
            column_descriptors=MIN_DESC,
            b_solvent_choices=MIN_BSOL,
            additive_choices=MIN_ADD,
        )


def test_close_to_target_objective_not_implemented_yet():
    with pytest.raises(NotImplementedError):
        _db.build_chrom_domain(
            gradient_scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
            column_choices=MIN_COLS,
            column_descriptors=MIN_DESC,
            b_solvent_choices=MIN_BSOL,
            additive_choices=MIN_ADD,
            objective_mode=_db.ObjectiveMode.CLOSE_TO_TARGET,
        )


# ───────────────────────────────────────────────────────────────────────
# materialize_gradient_program
# ───────────────────────────────────────────────────────────────────────

def test_materialize_hold_ramp_hold_emits_four_rows():
    program = _db.materialize_gradient_program(
        factor_values={
            "t_hold_init_min": 0.5,
            "pctB_init":       5.0,
            "t_grad_min":      8.0,
            "pctB_final":      95.0,
            "t_hold_final_min": 1.5,
        },
        scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
    )
    assert program == [
        {"time_min": 0.0,  "pctB":  5.0},
        {"time_min": 0.5,  "pctB":  5.0},
        {"time_min": 8.5,  "pctB": 95.0},
        {"time_min": 10.0, "pctB": 95.0},
    ]


def test_materialize_linear_emits_three_rows():
    program = _db.materialize_gradient_program(
        factor_values={
            "pctB_init":       5.0,
            "t_grad_min":     10.0,
            "pctB_final":     95.0,
            "t_hold_final_min": 0.0,
        },
        scheme=_db.GradientScheme.LINEAR,
    )
    assert len(program) == 3
    assert program[0]["pctB"] == 5.0
    assert program[-1]["time_min"] == 10.0


def test_materialize_program_is_monotonic_in_time_and_pctB():
    program = _db.materialize_gradient_program(
        factor_values={
            "t_hold_init_min":  1.0,
            "pctB_init":        2.0,
            "t_grad_min":       7.0,
            "pctB_final":      90.0,
            "t_hold_final_min": 2.0,
        },
        scheme=_db.GradientScheme.HOLD_RAMP_HOLD,
    )
    times = [r["time_min"] for r in program]
    pctBs = [r["pctB"] for r in program]
    assert times == sorted(times)
    assert pctBs == sorted(pctBs)
