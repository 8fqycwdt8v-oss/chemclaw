// apply-skills pre_turn hook.
//
// Wires the active-skill set into each turn by:
//   1. Prepending active skills' prompt.md bodies to the system message.
//   2. Filtering the tool list stored in scratchpad["skillFilteredTools"]
//      (the route reads this to override the tool catalog for the turn).
//
// This hook must run AFTER init-scratch (so scratchpad is initialised) and
// BEFORE the LLM call.

import type { Lifecycle } from "../lifecycle.js";
import type { PreTurnPayload } from "../types.js";
import type { HookJSONOutput } from "../hook-output.js";
import type { SkillLoader } from "../skills.js";
import type { Tool } from "../../tools/tool.js";

export function registerApplySkillsHook(lc: Lifecycle, loader: SkillLoader, allTools: Tool[]): void {
  lc.on(
    "pre_turn",
    "apply-skills",
    async (
      payload: PreTurnPayload,
      _toolUseID?: string,
      _options?: { signal: AbortSignal },
    ): Promise<HookJSONOutput> => {
      const { messages } = payload;

      // ── 1. Inject skill prompts into the system message. ─────────────────────
      const systemMsg = messages.find((m) => m.role === "system");
      if (systemMsg && loader.activeIds.size > 0) {
        systemMsg.content = loader.buildSystemPrompt(systemMsg.content);
      }

      // ── 2. Store filtered tools in scratchpad for the route to use. ─────────
      const filtered = loader.filterTools(allTools);
      payload.ctx.scratchpad.set("skillFilteredTools", filtered);
      return {};
    },
  );
}
