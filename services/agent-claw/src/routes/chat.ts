// Re-export shim. The chat route was split into focused submodules in PR-6
// (Wave 2). All implementation lives in ./chat/. This file preserves the
// existing import path `./routes/chat.js` so production code, tests, and
// any external callers keep compiling without churn.
//
// Submodule layout:
//   ./chat/index.ts              — registerChatRoute, ChatRouteDeps, StreamEvent
//   ./chat/sse-stream.ts         — sendStaticTextCompletion, sendSseError
//   ./chat/slash-shortcircuit.ts — pre-harness slash verbs
//   ./chat/session-resolution.ts — session load + system prompt
//   ./chat/turn-orchestration.ts — non-streaming + streaming run paths
//   ./chat/end-of-turn.ts        — streaming finally block

export { registerChatRoute } from "./chat/index.js";
export type { ChatRouteDeps, StreamEvent } from "./chat/index.js";
