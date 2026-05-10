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
 *
 * Defensive against non-JSON-safe inputs that would either crash
 * JSON.stringify (circular refs) or hash unstably (Date — `new Date()`
 * embedded in args produces a different ISO string per call). We pre-
 * normalize the common offenders so the hash is actually a stable
 * fingerprint of "the same tool call." Anything we can't normalize falls
 * through to a typeof-based placeholder rather than throwing.
 */
export function hashToolInput(input: unknown): string {
  const normalized = _normalize(input, new WeakSet());
  // JSON.stringify(undefined) returns undefined (not the string), and
  // JSON.stringify(() => {}) also returns undefined — but @types/node's
  // signature claims string. Cast through unknown so the runtime-true
  // undefined coalesces; eslint's `no-unnecessary-condition` would
  // otherwise reject the guard against a "type-impossible" undefined.
  let json: string;
  try {
    const raw = JSON.stringify(normalized) as unknown;
    json = typeof raw === "string" ? raw : "__undefined";
  } catch {
    json = `__unhashable:${typeof normalized}`;
  }
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function _normalize(v: unknown, seen: WeakSet<object>): unknown {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "bigint") return `__bigint:${(v as bigint).toString()}`;
  if (t === "function" || t === "symbol") return `__${t}`;
  if (v instanceof Date) return `__date:${v.toISOString()}`;
  // Detect cycles BEFORE recursing. v is now an object value; the WeakSet
  // tracks identities so a reused subtree doesn't recurse forever.
  if (seen.has(v)) return "__cycle";
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => _normalize(x, seen));
  if (v instanceof Map) {
    const entries: [string, unknown][] = [];
    for (const [k, val] of v.entries()) {
      entries.push([String(k), _normalize(val, seen)]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return { __map: entries };
  }
  if (v instanceof Set) {
    const items = Array.from(v).map((x) => _normalize(x, seen));
    // Stringify each element for sort comparison — we don't need
    // semantic ordering, just a deterministic one. Cast through unknown
    // so the runtime-undefined return value of JSON.stringify on
    // unrepresentable elements coalesces without tripping eslint.
    items.sort((a, b) => {
      const sa = (JSON.stringify(a) as unknown) ?? "";
      const sb = (JSON.stringify(b) as unknown) ?? "";
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    return { __set: items };
  }
  const sorted: Record<string, unknown> = {};
  const record = v as Record<string, unknown>;
  for (const k of Object.keys(record).sort()) {
    sorted[k] = _normalize(record[k], seen);
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
