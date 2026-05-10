// pre_tool hook: scheduled-substance-gate (gap-plan H0.9)
//
// Defense-in-depth deny-list for tool calls that reference verbatim canonical
// SMILES or InChIKeys of substances on the curated CWC Schedule-1 / DEA
// Schedule-I / EAR Cat 1C list (`src/data/scheduled-substances.ts`).
//
// What it catches: an LLM emitting a known scheduled-substance SMILES from
// training-corpus memory and feeding it into any chemistry tool (retrosynth,
// design_plate, run_program, etc.). The pre_tool dispatch sees every tool
// call uniformly, so this guards the entire builtin catalog without
// per-tool wiring.
//
// What it does NOT catch (by design — see follow-up BACKLOG entry):
//   - Tautomers, salts, isotopologues, alternate Kekulé forms, stereoisomer
//     drops. The hook does verbatim canonical-SMILES equality after a
//     light normalisation (whitespace strip). Substructure matching against
//     class SMARTS (e.g. novichok-class organophosphates, fentanyl analogues)
//     is the next layer; it requires a synchronous SMARTS engine on the
//     agent-claw side or an HTTP call to mcp_rdkit's substructure_match.
//     Both are deferred — see BACKLOG H0.9 follow-up.
//
// Decision aggregation:
//   - severity="deny" → permissionDecision: "deny" (blocks the tool call)
//   - severity="ask"  → permissionDecision: "ask"  (requires attestation)
// The lifecycle aggregator already enforces deny > ask > allow, so this
// hook composes correctly with budget-guard / foundation-citation-guard.
//
// Tenant override path: a `permission_policies` row with decision="allow"
// and a tighter argument_pattern can re-allow specific scheduled substances
// for tenants holding the right registration (DEA Schedule-I research
// licence, OPCW Article VI declaration, etc.). The resolver runs BEFORE
// pre_tool dispatch (see core/permissions/resolver.ts), so a tenant
// allow-policy will short-circuit this hook entirely.

import type { PreToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import {
  compileCatalog,
  looksLikeInchiKey,
  normaliseSmiles,
  type CompiledCatalog,
  type ScheduledSubstanceEntry,
} from "../../data/scheduled-substances.js";
import { getLogger } from "../../observability/logger.js";

const log = getLogger("scheduled-substance-gate");

// Module-level singleton — the catalog is small (≤100 entries by design)
// and immutable; compile once.
const DEFAULT_CATALOG: CompiledCatalog = compileCatalog();

// Recursion guard — input objects are typically <10 fields deep but the
// harness can pass arbitrary structured args (workflow_run definitions,
// design-plate matrices, etc.). Cap depth + visited count to avoid
// pathological cycles. Real cycles can't happen because tool inputs are
// JSON-serialisable, but defensive caps still apply.
const MAX_DEPTH = 8;
const MAX_STRINGS = 5_000;

interface ScanHit {
  readonly entry: ScheduledSubstanceEntry;
  readonly matched_value: string;
  readonly via: "smiles" | "inchikey";
}

/**
 * Walk a JSON-shaped value, yielding every string leaf along the way.
 * Stops emitting after MAX_STRINGS strings to bound work.
 */
function* walkStrings(input: unknown): Generator<string> {
  let count = 0;
  const stack: { value: unknown; depth: number }[] = [
    { value: input, depth: 0 },
  ];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const { value, depth } = next;
    if (count >= MAX_STRINGS) return;
    if (depth > MAX_DEPTH) continue;
    if (typeof value === "string") {
      count++;
      yield value;
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], depth: depth + 1 });
      }
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) {
        stack.push({ value: v, depth: depth + 1 });
      }
    }
  }
}

/**
 * Match a tool input against the compiled catalog. Returns the FIRST hit
 * (priority: deny entries before ask entries) so the caller can short-
 * circuit on the most-severe match.
 */
export function scanInputForScheduled(
  input: unknown,
  catalog: CompiledCatalog = DEFAULT_CATALOG,
): ScanHit | null {
  let firstAsk: ScanHit | null = null;
  for (const raw of walkStrings(input)) {
    // Cheap reject: SMILES + InChIKey are short. Shrugs off prose freely.
    if (raw.length === 0 || raw.length > 1024) continue;
    if (looksLikeInchiKey(raw)) {
      const entry = catalog.byInchiKey.get(raw.toUpperCase());
      if (entry) {
        const hit: ScanHit = { entry, matched_value: raw, via: "inchikey" };
        if (entry.severity === "deny") return hit;
        firstAsk ??= hit;
      }
    }
    // SMILES match: try the normalised value verbatim. Any string short
    // enough to be a SMILES is cheap to look up; the Map miss is O(1).
    const norm = normaliseSmiles(raw);
    if (norm.length === 0 || norm.length > 256) continue;
    const entry = catalog.bySmiles.get(norm);
    if (entry) {
      const hit: ScanHit = { entry, matched_value: raw, via: "smiles" };
      if (entry.severity === "deny") return hit;
      firstAsk ??= hit;
    }
  }
  return firstAsk;
}

function buildReason(hit: ScanHit, toolId: string): string {
  const lists = hit.entry.lists.join(", ");
  return (
    `scheduled-substance-gate: tool '${toolId}' input contains ${hit.via} ` +
    `match for ${hit.entry.name} (${lists}; severity=${hit.entry.severity}). ` +
    `If your work has authorised access (DEA registration / OPCW Article VI / ` +
    `EAR licence), an admin can grant a tenant-scoped permission_policies ` +
    `row to override this gate; otherwise revise the tool call to remove ` +
    `the listed substance.`
  );
}

/**
 * Pre-tool gate: returns a deny / ask decision when the tool input
 * contains a verbatim canonical-SMILES or InChIKey from the curated
 * scheduled-substance catalog.
 */
export async function scheduledSubstanceGateHook(
  payload: PreToolPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  const { input, toolId } = payload;
  const hit = scanInputForScheduled(input);
  if (!hit) return {};
  const reason = buildReason(hit, toolId);
  log.warn(
    {
      toolId,
      entry: hit.entry.name,
      lists: hit.entry.lists,
      via: hit.via,
      severity: hit.entry.severity,
    },
    "scheduled-substance match",
  );
  return {
    hookSpecificOutput: {
      hookEventName: "pre_tool",
      permissionDecision: hit.entry.severity === "deny" ? "deny" : "ask",
      permissionDecisionReason: reason,
    },
  };
}

/** Register the scheduled-substance-gate hook into a Lifecycle instance. */
export function registerScheduledSubstanceGateHook(
  lifecycle: Lifecycle,
): void {
  lifecycle.on(
    "pre_tool",
    "scheduled-substance-gate",
    scheduledSubstanceGateHook,
  );
}
