// services/agent-claw/src/core/streaming-sink.ts
//
// Notification surface for runHarness. When set, the harness drives text
// steps via llm.streamCompletion and emits these callbacks at the right
// lifecycle points. When undefined, the harness behaves as today: one
// llm.call per step, no token-by-token streaming.
//
// Modelled on the Claude Agent SDK's SDKMessage shape but as a callback
// contract instead of an AsyncGenerator. Routes (chat.ts, deep-research.ts)
// adapt this into SSE events via streaming/sse-sink.ts (Phase 2B).

/**
 * Snapshot of one todo as surfaced through onTodoUpdate. Mirrors the
 * `TodoOut` Zod schema in tools/builtins/manage_todos.ts but redeclared
 * here so this module has no dependency on tool-side types.
 */
export interface TodoSnapshot {
  id: string;
  ordering: number;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface StreamSink {
  /** Fires once at the start of a streamed turn with the session id (if any). */
  onSession?: (sessionId: string) => void;
  /** Fires for each text delta from the LLM stream. */
  onTextDelta?: (delta: string) => void;
  /** Fires once per tool call before the tool executes (after pre_tool hooks). */
  onToolCall?: (toolId: string, input: unknown) => void;
  /** Fires once per tool call after the tool returns (after post_tool hooks). */
  onToolResult?: (toolId: string, output: unknown) => void;
  /** Fires whenever manage_todos mutates the checklist. */
  onTodoUpdate?: (todos: TodoSnapshot[]) => void;
  /** Fires when ask_user pauses the loop. */
  onAwaitingUserInput?: (question: string) => void;
  /** Fires once at end of turn with the finish reason + usage. */
  onFinish?: (
    reason: string,
    usage: { promptTokens: number; completionTokens: number },
  ) => void;
}
