// ---------------------------------------------------------------------------
// Stable error code enum used across SSE error frames, MCP error responses,
// and `error_events` rows.
//
// The shape is additive over the existing flat envelope: `error` remains
// the code STRING (so every existing client keeps working), while new
// fields (`message`, `trace_id`, `request_id`, `hint`, `detail`) sit
// alongside it. See `envelope.ts` for the helper that builds the shape.
//
// Mirrored on the Python side at
// `services/mcp_tools/common/error_codes.py`. Adding a code requires
// matching changes in both places — a parity test is added in
// `tests/parity/error-codes-parity.test.ts` if/when one is needed.
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  // --- Agent / harness -----------------------------------------------------
  AGENT_BUDGET_EXCEEDED: "AGENT_BUDGET_EXCEEDED",
  SESSION_BUDGET_EXCEEDED: "SESSION_BUDGET_EXCEEDED",
  AGENT_AWAITING_USER_INPUT: "AGENT_AWAITING_USER_INPUT",
  AGENT_OPTIMISTIC_LOCK: "AGENT_OPTIMISTIC_LOCK",
  AGENT_PLAN_PARSE_FAILED: "AGENT_PLAN_PARSE_FAILED",
  AGENT_HOOK_FAILED: "AGENT_HOOK_FAILED",
  AGENT_TOOL_FAILED: "AGENT_TOOL_FAILED",
  AGENT_CONFIG_INVALID: "AGENT_CONFIG_INVALID",
  AGENT_UNAUTHENTICATED: "AGENT_UNAUTHENTICATED",
  AGENT_INTERNAL: "AGENT_INTERNAL",
  AGENT_CANCELLED: "AGENT_CANCELLED",
  AGENT_INVALID_INPUT: "AGENT_INVALID_INPUT",

  // --- MCP services --------------------------------------------------------
  MCP_BAD_REQUEST: "MCP_BAD_REQUEST",
  MCP_NOT_FOUND: "MCP_NOT_FOUND",
  MCP_NOT_IMPLEMENTED: "MCP_NOT_IMPLEMENTED",
  MCP_UPSTREAM_FAILED: "MCP_UPSTREAM_FAILED",
  MCP_UNAVAILABLE: "MCP_UNAVAILABLE",
  MCP_TIMEOUT: "MCP_TIMEOUT",
  MCP_AUTH_FAILED: "MCP_AUTH_FAILED",
  MCP_SCOPE_DENIED: "MCP_SCOPE_DENIED",
  MCP_REDACTION_FAILED: "MCP_REDACTION_FAILED",

  // --- Database / RLS ------------------------------------------------------
  DB_RLS_DENIED: "DB_RLS_DENIED",
  DB_RLS_NO_USER_CONTEXT: "DB_RLS_NO_USER_CONTEXT",
  DB_OPTIMISTIC_LOCK: "DB_OPTIMISTIC_LOCK",
  DB_RECONNECT: "DB_RECONNECT",
  DB_SLOW_QUERY: "DB_SLOW_QUERY",

  // --- Projectors ----------------------------------------------------------
  PROJECTOR_HANDLER_FAILED_TRANSIENT: "PROJECTOR_HANDLER_FAILED_TRANSIENT",
  PROJECTOR_HANDLER_FAILED_PERMANENT: "PROJECTOR_HANDLER_FAILED_PERMANENT",

  // --- Paperclip -----------------------------------------------------------
  PAPERCLIP_BUDGET_DENIED: "PAPERCLIP_BUDGET_DENIED",
  PAPERCLIP_PERSIST_FAILED: "PAPERCLIP_PERSIST_FAILED",

  // --- LLM ----------------------------------------------------------------
  LLM_REDACTION_FAILED: "LLM_REDACTION_FAILED",
  LLM_PROVIDER_FAILED: "LLM_PROVIDER_FAILED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
