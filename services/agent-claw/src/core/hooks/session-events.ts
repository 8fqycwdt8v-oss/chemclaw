// Phase 4B: session-events
//
// Default no-op handler for the session_start lifecycle point. This is the
// canonical "logging hook" attachment surface — operators can swap in a
// telemetry sink (Langfuse session, OTel span, app log) by replacing the
// implementation here, without altering the harness.
//
// Registering on session_start (rather than session_end) covers both create
// and resume paths: chat.ts dispatches session_start with source="create"
// for fresh sessions and source="resume" when a prior session is rehydrated.

import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import type { SessionStartPayload } from "../types.js";

export async function sessionEventsHook(
  _payload: SessionStartPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  // Intentionally a no-op. Replace with a telemetry-emitting implementation
  // (e.g. langfuse.event({ name: "session.start", ... })) as needed.
  return {};
}

/**
 * Register the session-events hook. Currently only attaches to session_start
 * — extend with a session_end registration if/when a corresponding handler
 * is wired.
 */
export function registerSessionEventsHook(lifecycle: Lifecycle): void {
  lifecycle.on("session_start", "session-events", sessionEventsHook);
}
