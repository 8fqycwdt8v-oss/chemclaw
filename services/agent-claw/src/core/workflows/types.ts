// Workflow DSL types — JSON-only; the agent constructs these and passes
// them to workflow_define. The validator (validator.ts) round-trips Zod
// before any DB write so a malformed definition fails fast with a
// human-readable error.

import { z } from "zod";

const StepBase = z.object({
  id: z.string().min(1).max(64),
  description: z.string().optional(),
  when: z.string().optional().describe("JMESPath expr over the run scope."),
});

export const ToolCallStep = StepBase.extend({
  kind: z.literal("tool_call"),
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const SubAgentStep = StepBase.extend({
  kind: z.literal("sub_agent"),
  skill: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
});

export const WaitStep = StepBase.extend({
  kind: z.literal("wait"),
  for: z.union([
    z.object({ batch_id: z.string().describe("JMESPath expr resolving to a batch_id") }),
    z.object({ event: z.literal("workflow_event"), match: z.record(z.string(), z.unknown()) }),
  ]),
  timeout_seconds: z.number().int().positive().default(3600),
});

// Conditional / Loop / Parallel use z.lazy because they reference Step recursively.
export type Step =
  | z.infer<typeof ToolCallStep>
  | z.infer<typeof SubAgentStep>
  | z.infer<typeof WaitStep>
  | { id: string; kind: "conditional"; when: string; then_steps: Step[]; else_steps?: Step[] }
  | { id: string; kind: "loop"; for_each: string; as: string; body: Step[]; parallel?: boolean; max_concurrency?: number }
  | { id: string; kind: "parallel"; branches: Step[][] };

export const Step: z.ZodType<Step, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    ToolCallStep,
    SubAgentStep,
    WaitStep,
    StepBase.extend({
      kind: z.literal("conditional"),
      when: z.string(),
      then_steps: z.array(Step),
      else_steps: z.array(Step).optional(),
    }),
    StepBase.extend({
      kind: z.literal("loop"),
      for_each: z.string(),
      as: z.string().min(1).max(32),
      body: z.array(Step),
      parallel: z.boolean().default(false),
      max_concurrency: z.number().int().min(1).max(64).default(4),
    }),
    StepBase.extend({
      kind: z.literal("parallel"),
      branches: z.array(z.array(Step)).min(1),
    }),
  ]),
);

export const WorkflowDefinition = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(Step).min(1),
  outputs: z.record(z.string(), z.string()).optional()
    .describe("Named output → JMESPath over scope to populate it."),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
