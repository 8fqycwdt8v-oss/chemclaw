// Re-export shim. The sessions routes were split into focused submodules
// in PR-6 (Wave 2). All implementation lives in ./sessions/, with the
// chained-harness helper hoisted to ../core/chained-harness.ts. This file
// preserves the existing import paths `./routes/sessions.js` (production
// code) and the `runChainedHarness` named export (integration tests).
//
// Submodule layout:
//   ./sessions/index.ts            — registerSessionsRoute, GET endpoints
//   ./sessions/plan-handlers.ts    — POST /plan/run
//   ./sessions/resume-handlers.ts  — POST /resume + /internal/resume
//   ../core/chained-harness.ts     — runChainedHarness multi-turn loop

export { registerSessionsRoute } from "./sessions/index.js";
export { runChainedHarness } from "../core/chained-harness.js";
export type {
  ChainedHarnessOptions,
  ChainedHarnessResult,
} from "../core/chained-harness.js";
