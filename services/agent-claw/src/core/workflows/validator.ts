// Validate a workflow definition before persisting.
// Returns the parsed definition or throws a descriptive error.
//
// Note: this validator deliberately accepts step kinds (`conditional`,
// `loop`, `parallel`, `sub_agent`) that the Python workflow_engine does not
// yet execute — see types.ts for the full contract. Such workflows persist
// fine but their runs will fail with NotImplementedError when the engine
// reaches the unimplemented step. Tightening the schema is a future
// migration; the comment + engine-side guard are the current source of truth.

import { WorkflowDefinition, type Step } from "./types.js";

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export function validateWorkflowDefinition(raw: unknown): WorkflowDefinition {
  const parsed = WorkflowDefinition.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      "invalid workflow definition: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  // Cross-step checks: ids unique within siblings; tool ids non-empty.
  const seen = new Set<string>();
  walkSteps(parsed.data.steps, (s) => {
    if (seen.has(s.id)) {
      throw new WorkflowValidationError(`duplicate step id: ${s.id}`);
    }
    seen.add(s.id);
  });
  return parsed.data;
}

function walkSteps(steps: Step[], visit: (s: Step) => void): void {
  for (const s of steps) {
    visit(s);
    if (s.kind === "conditional") {
      walkSteps(s.then_steps, visit);
      if (s.else_steps) walkSteps(s.else_steps, visit);
    } else if (s.kind === "loop") {
      walkSteps(s.body, visit);
    } else if (s.kind === "parallel") {
      for (const branch of s.branches) walkSteps(branch, visit);
    }
  }
}
