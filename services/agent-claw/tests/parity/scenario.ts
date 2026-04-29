// Phase 11: Mock parity harness — scenario definition shared by every JSON
// fixture under tests/parity/scenarios. Modeled on the ultraworkers/claw-code
// MOCK_PARITY_HARNESS.md pattern. Operators add a JSON file describing what
// the LLM does plus what events the harness should emit, and the runner
// verifies the live trace matches.

/**
 * One enqueued LLM response. The runner translates each step into a
 * StubLlmProvider response (text, single tool_call, or a streamed batch of
 * deltas) PLUS, for tool_call steps, the canned tool output the scenario's
 * stubbed tool returns.
 */
export interface ScenarioStep {
  llm_response:
    | { kind: "tool_call"; toolId: string; input: Record<string, unknown> }
    | {
        kind: "tool_calls";
        calls: Array<{
          toolId: string;
          input: Record<string, unknown>;
          /** Output the runner's stub will return for this individual call. */
          output?: unknown;
        }>;
      }
    | { kind: "text"; text: string }
    | { kind: "stream"; deltas: string[] };
  /** Returned by the scenario's stubbed tool when this step is a tool_call. */
  tool_output?: unknown;
}

/**
 * One expected event in the captured trace. Every field except `type` is
 * optional and matched best-effort: when a field is set on the expected
 * event it must equal the same field on a trace entry. Fields absent from
 * the expected event are ignored on the trace entry. assertEventsMatch
 * checks that every expected event appears IN ORDER, allowing extra events
 * between matches (this is "expected is a subsequence of trace" rather
 * than "expected equals trace exactly", so harness changes that add new
 * hooks / events don't churn every scenario).
 */
export interface ExpectedEvent {
  /** "session" | "hook" | "tool_call" | "tool_result" | "text_delta" | "todo_update" | "awaiting_user_input" | "finish" */
  type: string;
  /** Lifecycle hook point — only meaningful for type === "hook". */
  point?: string;
  /** Tool id — meaningful for type in {"hook" (matcher target), "tool_call", "tool_result"}. */
  toolId?: string;
  /** Finish reason — only meaningful for type === "finish". */
  finishReason?: string;
}

/**
 * Optional ad-hoc lifecycle hook the runner registers before driving the
 * harness. Lets a scenario exercise behaviours that depend on a specific
 * hook (e.g. a deny at pre_tool) without authoring TS code.
 */
export interface ScenarioHook {
  /** A HookPoint string, e.g. "pre_tool". Matched against Lifecycle's API. */
  point: string;
  /** Diagnostic name — surfaces in lifecycle logs / spans. */
  name: string;
  /** Optional regex (matched against the dispatch matcherTarget — typically the toolId). */
  matcher?: string;
  /** What the hook does when it fires. */
  behavior: "allow" | "deny" | "noop";
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
 * Used to construct the Budget passed to runHarness. Lets a scenario tune
 * caps to exercise specific paths (e.g. low maxPromptTokens to trigger
 * pre_compact / post_compact dispatch).
 */
export interface ScenarioBudget {
  maxSteps?: number;
  maxPromptTokens?: number;
}

/**
 * Override the LLM-reported usage on individual steps. Indexed by step
 * position (0-based) → usage object. Used to trip pre_compact (default
 * compaction threshold is 60% of maxPromptTokens) deterministically without
 * needing real long-context messages.
 */
export interface ScenarioStepUsageOverrides {
  [stepIndex: string]: { promptTokens: number; completionTokens: number };
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
  /** Optional usage overrides keyed by step index. */
  step_usage_overrides?: ScenarioStepUsageOverrides;
  /** Events that MUST appear (in order) in the captured trace. */
  expected_events: ExpectedEvent[];
  /** Final HarnessResult.finishReason. */
  expected_finish_reason: string;
}
