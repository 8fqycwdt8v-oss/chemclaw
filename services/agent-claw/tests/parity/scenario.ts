// Phase 11: Mock parity harness — scenario definition shared by every JSON
// fixture under tests/parity/scenarios.
//
// NOTE on adaptation to current main: the original Phase 11 design (commit
// c0c949e on the claw-code branch) traced StreamSink callbacks
// (onSession / onTextDelta / onToolCall / onToolResult / onFinish / ...)
// alongside lifecycle.dispatch events. main does not have a StreamSink
// (Phase 2A was never cherry-picked onto this branch). This port traces
// LIFECYCLE DISPATCH EVENTS ONLY, which is the most reliable contract
// surface available on main without porting more upstream phases. JSON
// fixtures express their expectations as a sequence of `{type:"hook", ...}`
// entries plus a top-level `expected_finish_reason`.
//
// Operators add a JSON file describing what the LLM does plus what hook
// dispatches the harness should emit, and the runner verifies the live
// trace matches.

/**
 * One enqueued LLM response. The runner translates each step into a
 * StubLlmProvider response (text or single tool_call) PLUS, for tool_call
 * steps, the canned tool output the scenario's stubbed tool returns.
 *
 * The "stream" and "tool_calls" (plural / parallel batch) shapes from the
 * original Phase 11 design are intentionally absent — main has no parallel
 * batch path, and streaming is exercised via separate unit tests.
 */
export interface ScenarioStep {
  llm_response:
    | { kind: "tool_call"; toolId: string; input: Record<string, unknown> }
    | { kind: "text"; text: string };
  /** Returned by the scenario's stubbed tool when this step is a tool_call. */
  tool_output?: unknown;
}

/**
 * One expected event in the captured trace. Every field except `type` is
 * optional and matched best-effort: when a field is set on the expected
 * event it must equal the same field on a trace entry. assertEventsMatch
 * checks that every expected event appears IN ORDER, allowing extra events
 * between matches (this is "expected is a subsequence of trace" rather
 * than "expected equals trace exactly", so harness changes that add new
 * hooks don't churn every scenario).
 *
 * On this branch the only legal `type` is `"hook"`. Future ports of
 * Phase 2A's StreamSink can extend this union without breaking existing
 * fixtures.
 */
export interface ExpectedEvent {
  type: "hook";
  /** Lifecycle hook point. Required for every entry. */
  point: string;
  /** Tool id matched against the dispatch matcherTarget. Optional. */
  toolId?: string;
}

/**
 * Optional ad-hoc lifecycle hook the runner registers before driving the
 * harness. Lets a scenario exercise behaviours that depend on a specific
 * hook (e.g. a deny at permission_request) without authoring TS code.
 *
 * `behavior: "deny"` is only legal at `permission_request` — the hook
 * returns the SDK-shape `{ hookSpecificOutput: { permissionDecision: "deny" } }`
 * which the lifecycle's `dispatchPermissionRequest` aggregator honours.
 * On other hook points main's contract is `Promise<void>` — there is no
 * deny channel via hook return value (a hook may `throw` to abort, but
 * that surfaces as an uncaught error rather than a clean denial), so the
 * runner refuses to wire `deny` on those points.
 */
export interface ScenarioHook {
  /** A HookPoint string, e.g. "permission_request". */
  point: string;
  /** Diagnostic name — surfaces in lifecycle logs / spans. */
  name: string;
  /** What the hook does when it fires. */
  behavior: "noop" | "deny";
}

/**
 * Permission policy passed straight to runHarness via HarnessOptions.
 * Same shape as PermissionOptions; redeclared here so JSON fixtures don't
 * need to know the TS type.
 */
export interface ScenarioPermissions {
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/**
 * Optional Budget overrides. Defaults to maxSteps=10, maxPromptTokens=100_000.
 */
export interface ScenarioBudget {
  maxSteps?: number;
  maxPromptTokens?: number;
}

export interface Scenario {
  /** Short name shown in the test runner. */
  name: string;
  /** What this scenario verifies, for human readers. */
  description: string;
  /** User messages that seed the conversation history before runHarness fires. */
  user_messages: string[];
  /** LLM responses + tool outputs, in order. */
  steps: ScenarioStep[];
  /** Optional permission policy. */
  permissions?: ScenarioPermissions;
  /** Optional ad-hoc hooks the runner registers into the Lifecycle. */
  hooks?: ScenarioHook[];
  /** Optional Budget caps. */
  budget?: ScenarioBudget;
  /** Hook events that MUST appear (in order) in the captured trace. */
  expected_events: ExpectedEvent[];
  /** Final HarnessResult.finishReason. */
  expected_finish_reason: string;
}

/**
 * One captured event. The runner appends one of these per dispatch.
 */
export interface TraceEvent {
  type: "hook";
  point: string;
  toolId?: string;
}
