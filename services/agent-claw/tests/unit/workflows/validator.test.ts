// Tests for the WorkflowDefinition Zod schema + validator.

import { describe, it, expect } from "vitest";
import {
  validateWorkflowDefinition,
  WorkflowValidationError,
} from "../../../src/core/workflows/validator.js";

const minimalDef = {
  name: "min-wf",
  steps: [{ id: "s1", kind: "tool_call", tool: "qm_single_point", args: { smiles: "CCO" } }],
};

describe("validateWorkflowDefinition", () => {
  it("accepts a minimal tool_call workflow", () => {
    const def = validateWorkflowDefinition(minimalDef);
    expect(def.name).toBe("min-wf");
    expect(def.steps).toHaveLength(1);
  });

  it("rejects missing name", () => {
    expect(() => validateWorkflowDefinition({ steps: minimalDef.steps })).toThrow(
      WorkflowValidationError,
    );
  });

  it("rejects empty steps array", () => {
    expect(() => validateWorkflowDefinition({ name: "x", steps: [] })).toThrow(
      WorkflowValidationError,
    );
  });

  it("rejects unknown step kind", () => {
    expect(() =>
      validateWorkflowDefinition({
        name: "x",
        steps: [{ id: "s", kind: "magic_step", tool: "x" }],
      }),
    ).toThrow(WorkflowValidationError);
  });

  it("rejects duplicate step ids across siblings", () => {
    expect(() =>
      validateWorkflowDefinition({
        name: "x",
        steps: [
          { id: "dup", kind: "tool_call", tool: "qm_single_point", args: {} },
          { id: "dup", kind: "tool_call", tool: "qm_single_point", args: {} },
        ],
      }),
    ).toThrow(/duplicate step id/);
  });

  it("rejects duplicate step ids across nested branches", () => {
    expect(() =>
      validateWorkflowDefinition({
        name: "x",
        steps: [
          {
            id: "outer",
            kind: "conditional",
            when: "scope.foo",
            then_steps: [
              { id: "inner", kind: "tool_call", tool: "qm_single_point", args: {} },
            ],
            else_steps: [
              { id: "inner", kind: "tool_call", tool: "qm_single_point", args: {} },
            ],
          },
        ],
      }),
    ).toThrow(/duplicate step id/);
  });

  it("accepts a loop step with body", () => {
    const def = validateWorkflowDefinition({
      name: "loopy",
      steps: [
        {
          id: "outer",
          kind: "loop",
          for_each: "scope.items",
          as: "item",
          body: [
            { id: "iter", kind: "tool_call", tool: "qm_single_point", args: {} },
          ],
          parallel: false,
          max_concurrency: 4,
        },
      ],
    });
    expect(def.steps[0].kind).toBe("loop");
  });

  it("accepts a wait step on batch_id", () => {
    const def = validateWorkflowDefinition({
      name: "waity",
      steps: [
        {
          id: "wait",
          kind: "wait",
          for: { batch_id: "scope.steps.x.batch_id" },
          timeout_seconds: 600,
        },
      ],
    });
    expect(def.steps[0].kind).toBe("wait");
  });

  it("accepts a parallel step with branches", () => {
    const def = validateWorkflowDefinition({
      name: "parallely",
      steps: [
        {
          id: "p",
          kind: "parallel",
          branches: [
            [{ id: "a", kind: "tool_call", tool: "qm_single_point", args: {} }],
            [{ id: "b", kind: "tool_call", tool: "qm_single_point", args: {} }],
          ],
        },
      ],
    });
    expect(def.steps[0].kind).toBe("parallel");
  });
});
