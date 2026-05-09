// pre_tool hook: loop-detector
//
// Detects when the model is calling the same tool with substantially the
// same arguments repeatedly — a strong signal that it's stuck on a broken
// path (transient MCP failure, model fixated on a bad strategy, infinite
// retry on the same query). The hook tracks recent (toolId, hash(args))
// signatures in ctx.scratchpad and appends to scratchpad.loop_warnings
// when a signature reappears ≥ STUCK_THRESHOLD times within the recent
// window.
//
// At STUCK_THRESHOLD the hook is observe-only — it lets the call through so
// a single retry on a transient flake still works, but appends a warning
// the reflection prompt surfaces on the next max_steps boundary.
//
// At HARD_DENY_THRESHOLD the hook returns permissionDecision="deny" via
// hookSpecificOutput. runOneTool short-circuits with a synthetic
// `denied_by_hook` envelope and the LLM sees it on the next iteration —
// forcing it to change strategy or call ask_user. We return deny rather
// than throw because throwing would kill the harness loop; deny gives the
// model a chance to recover within the same turn.

import { createHash } from "node:crypto";
import type { PreToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";

// Public so tests + the reflection-prompt builder can read these without
// reaching into the hook's source.
export const RECENT_TOOL_CALLS_KEY = "recent_tool_calls";
export const LOOP_WARNINGS_KEY = "loop_warnings";

/** Window of recent tool calls considered for repeat detection. */
export const RECENT_WINDOW = 10;

/** Soft threshold — emits a warning that the reflection prompt surfaces. */
export const STUCK_THRESHOLD = 3;

/**
 * Hard threshold — denies the call so the model is forced off the broken
 * path. 5 was chosen so a transient flake (1–2 retries) doesn't trip it
 * but a genuine fixation does. Higher than STUCK_THRESHOLD so the model
 * gets the warning first and has a chance to self-correct.
 */
export const HARD_DENY_THRESHOLD = 5;

export interface RecentToolCall {
  toolId: string;
  /** Stable hash of the normalized arguments (sha-256, hex, first 16 chars). */
  argsHash: string;
  /** ISO timestamp; bookkeeping only, not used for matching. */
  ts: string;
}

export interface LoopWarning {
  toolId: string;
  argsHash: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Stable hash of tool input. JSON.stringify is order-sensitive for objects;
 * we sort keys recursively so `{a:1,b:2}` and `{b:2,a:1}` collide. Returns
 * a 16-char hex prefix of sha-256 — collision-resistant enough for a per-
 * session bounded log without bloating the scratchpad row.
 */
export function hashToolInput(input: unknown): string {
  const normalized = _normalize(input);
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function _normalize(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(_normalize);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    sorted[k] = _normalize((v as Record<string, unknown>)[k]);
  }
  return sorted;
}

export async function loopDetectorHook(
  payload: PreToolPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  const sp = payload.ctx.scratchpad;
  const argsHash = hashToolInput(payload.input);
  const now = new Date().toISOString();

  const recent = (sp.get(RECENT_TOOL_CALLS_KEY) as RecentToolCall[] | undefined) ?? [];
  const updated: RecentToolCall[] = [
    ...recent.slice(-(RECENT_WINDOW - 1)),
    { toolId: payload.toolId, argsHash, ts: now },
  ];
  sp.set(RECENT_TOOL_CALLS_KEY, updated);

  const occurrences = updated.filter(
    (e) => e.toolId === payload.toolId && e.argsHash === argsHash,
  ).length;

  if (occurrences >= STUCK_THRESHOLD) {
    const warnings =
      (sp.get(LOOP_WARNINGS_KEY) as LoopWarning[] | undefined) ?? [];
    const existing = warnings.find(
      (w) => w.toolId === payload.toolId && w.argsHash === argsHash,
    );
    if (existing) {
      existing.occurrences = occurrences;
      existing.lastSeen = now;
    } else {
      warnings.push({
        toolId: payload.toolId,
        argsHash,
        occurrences,
        firstSeen: now,
        lastSeen: now,
      });
    }
    // Keep the warnings list bounded so a long-running session doesn't
    // accumulate forever; oldest dropped.
    sp.set(LOOP_WARNINGS_KEY, warnings.slice(-20));
  }

  if (occurrences >= HARD_DENY_THRESHOLD) {
    return {
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "deny",
        permissionDecisionReason:
          `loop-detector: tool '${payload.toolId}' called ${occurrences} times ` +
          `with the same arguments within the last ${RECENT_WINDOW} steps. ` +
          `Reflect: is the input wrong, the upstream service down, or the ` +
          `approach mistaken? Try different arguments, a different tool, or ` +
          `call ask_user to escalate.`,
      },
    };
  }

  return {};
}

export function registerLoopDetectorHook(lifecycle: Lifecycle): void {
  lifecycle.on("pre_tool", "loop-detector", loopDetectorHook);
}
