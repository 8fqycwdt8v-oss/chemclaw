// Eval sub-command parser re-exported from core/slash.ts for use in routes.
// We re-export the type and function to avoid a circular import between
// routes/eval.ts → core/slash.ts → routes/* (which doesn't exist but is
// defensive).
export type { EvalSubCommand } from "../core/slash.js";
export { parseEvalArgs } from "../core/slash.js";
