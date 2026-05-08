// session_end hook — closes any per-session E2B sandbox cached on the
// scratchpad by acquireSessionSandbox.
//
// Without this hook a session-cached sandbox would only be closed when
// the agent process exits. The hook fires on every session_end
// dispatch, including the awaiting_user_input + finished_max_steps
// + stop / cancelled paths, so an idle session releases its sandbox
// immediately rather than holding the E2B slot for hours.
//
// Failures are logged and dropped: a sandbox that fails to close has
// already been removed from the scratchpad, so the worst case is the
// sandbox lingers on the E2B side until its own template TTL expires.

import type { Lifecycle } from "../lifecycle.js";
import type { SandboxClient } from "../sandbox.js";
import type { HookJSONOutput } from "../hook-output.js";
import type { SessionEndPayload } from "../types.js";
import { closeSessionSandbox } from "../session-sandbox.js";

export function registerSessionSandboxCloseHook(
  lifecycle: Lifecycle,
  client: SandboxClient | null,
): void {
  lifecycle.on(
    "session_end",
    "session-sandbox-close",
    async (payload: SessionEndPayload): Promise<HookJSONOutput> => {
      // Sandbox client is optional in the bootstrap (forged tools may
      // not be set up). If absent, there's nothing for the cache to
      // hold — and closeSessionSandbox would have nothing to do anyway.
      if (!client) return {};
      await closeSessionSandbox(payload.ctx, client);
      return {};
    },
  );
}
