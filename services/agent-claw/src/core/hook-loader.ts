// YAML hook loader.
//
// Reads hooks/*.yaml at startup (path from env HOOKS_DIR, default <repo-root>/hooks).
// Each YAML defines a hook that gets registered into the Lifecycle dispatcher
// via the BUILTIN_REGISTRARS map. Hooks with a `script` field dynamically
// import the module — supported but no script-based hooks ship today.
//
// As of v1.2.0 this is the single source of truth for hook registration on
// the production startup path. The 11 built-in hooks register here; new hooks
// require both a YAML file in hooks/ AND an entry in BUILTIN_REGISTRARS.
//
// YAML shape (Phase 4 of the configuration concept extends with order /
// condition / timeout_ms):
//   name: <string>
//   lifecycle: pre_turn | pre_tool | post_tool | pre_compact | post_turn | …
//   enabled: true | false
//   order: <number — lower fires first within a lifecycle phase; default 100>
//   timeout_ms: <number — overrides the 60s per-hook default>
//   condition:
//     setting_key: <config_settings key — falsy DB value disables the hook>
//     env_var:     <env var name — alternative to setting_key>
//     default:     <boolean — used when neither source has a value>
//   script: <optional JS file path relative to this service>
//   definition:
//     <hook-type-specific fields>

import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import type { Pool } from "pg";
import type { Lifecycle } from "./lifecycle.js";
import type { HookPoint } from "./types.js";
import type { LlmProvider } from "../llm/provider.js";
import type { SkillLoader } from "./skills.js";
import type { Tool } from "../tools/tool.js";
import { registerRedactSecretsHook } from "./hooks/redact-secrets.js";
import { registerTagMaturityHook } from "./hooks/tag-maturity.js";
import { registerBudgetGuardHook } from "./hooks/budget-guard.js";
import { registerInitScratchHook } from "./hooks/init-scratch.js";
import { registerAntiFabricationHook } from "./hooks/anti-fabrication.js";
import { registerFoundationCitationGuardHook } from "./hooks/foundation-citation-guard.js";
import { registerSourceCacheHook } from "./hooks/source-cache.js";
import { registerCompactWindowHook } from "./hooks/compact-window.js";
import { registerApplySkillsHook } from "./hooks/apply-skills.js";
import { registerSessionEventsHook } from "./hooks/session-events.js";
import { registerPermissionHook } from "./hooks/permission.js";

// ---------------------------------------------------------------------------
// YAML schema (validated at load time).
// ---------------------------------------------------------------------------

const VALID_HOOK_POINTS = new Set<string>([
  "pre_turn",
  "pre_tool",
  "post_tool",
  "pre_compact",
  "post_compact",
  "post_turn",
  // Phase 4B additions:
  "session_start",
  "session_end",
  "user_prompt_submit",
  "post_tool_failure",
  "post_tool_batch",
  "permission_request",
  "subagent_start",
  "subagent_stop",
  "task_created",
  "task_completed",
]);

interface HookCondition {
  setting_key?: string;
  env_var?: string;
  default?: boolean;
}

interface HookYaml {
  name?: string;
  lifecycle?: string;
  // `enabled` is optional in YAML — undefined and true both mean "enabled";
  // only an explicit `enabled: false` disables the hook (see registration loop).
  enabled?: boolean;
  // Phase 4 of the configuration concept: optional ordering + condition +
  // timeout. None of these is required; the loader falls back to current
  // defaults (registration order, 60s timeout, always enabled).
  order?: number;
  timeout_ms?: number;
  condition?: HookCondition;
  script?: string;
  definition?: Record<string, unknown>;
}

const DEFAULT_HOOK_ORDER = 100;

// ---------------------------------------------------------------------------
// Hook dependencies — passed to every registrar so source-cache can get a
// pool, compact-window can get an LLM + token budget, apply-skills can get
// the skill loader + the live tool catalog, etc.
//
// `loadHooks` is the single source of truth for which hooks register; the
// caller (index.ts) is responsible for assembling the deps object.
// ---------------------------------------------------------------------------

export interface HookDeps {
  pool: Pool;
  llm: LlmProvider;
  skillLoader: SkillLoader;
  allTools: Tool[];
  /** AGENT_TOKEN_BUDGET — used by the compact-window pre_compact hook. */
  tokenBudget: number;
}

type BuiltinRegistrar = (lifecycle: Lifecycle, deps: HookDeps) => void;

const BUILTIN_REGISTRARS = new Map<string, BuiltinRegistrar>([
  ["redact-secrets", (lc) => { registerRedactSecretsHook(lc); }],
  // Pool is needed for the artifact-row INSERT path (ARTIFACT_TOOL_IDS like
  // propose_hypothesis). Without it the hook silently skips persistence.
  ["tag-maturity", (lc, deps) => { registerTagMaturityHook(lc, deps.pool); }],
  ["budget-guard", (lc) => { registerBudgetGuardHook(lc); }],
  ["init-scratch", (lc) => { registerInitScratchHook(lc); }],
  ["anti-fabrication", (lc) => { registerAntiFabricationHook(lc); }],
  ["foundation-citation-guard", (lc) => { registerFoundationCitationGuardHook(lc); }],
  ["source-cache", (lc, deps) => { registerSourceCacheHook(lc, deps.pool); }],
  [
    "compact-window",
    (lc, deps) =>
      { registerCompactWindowHook(lc, {
        llm: deps.llm,
        tokenBudget: deps.tokenBudget,
      }); },
  ],
  [
    "apply-skills",
    (lc, deps) => { registerApplySkillsHook(lc, deps.skillLoader, deps.allTools); },
  ],
  // Phase 4B: no-op session-events hook gives operators a YAML-discoverable
  // attach point for session_start telemetry without forcing a code change.
  ["session-events", (lc) => { registerSessionEventsHook(lc); }],
  // Phase 6: no-op permission hook — operators replace with custom policy.
  // Registers at permission_request; the route-level resolver dispatches
  // before pre_tool, so a custom policy here gates tools BEFORE the
  // budget-guard / foundation-citation-guard pre_tool chain runs.
  ["permission", (lc) => { registerPermissionHook(lc); }],
]);

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface HookLoadResult {
  /** Number of YAML files found. */
  filesFound: number;
  /** Number of hooks registered (enabled + valid). */
  registered: number;
  /** Hooks skipped due to disabled=true or invalid YAML. */
  skipped: string[];
}

/**
 * Load all hooks/*.yaml from hooksDir and register enabled hooks into lifecycle.
 *
 * @param lifecycle  The Lifecycle instance to register hooks into.
 * @param deps       Dependencies passed to each registrar (pool, llm, skill loader, tool list, token budget).
 * @param hooksDir   Directory containing *.yaml files. Defaults to <repo-root>/hooks.
 */
export async function loadHooks(
  lifecycle: Lifecycle,
  deps: HookDeps,
  hooksDir?: string,
): Promise<HookLoadResult> {
  // Resolve default hooks dir: ../../../../hooks relative to this file in dist.
  // At runtime: services/agent-claw/dist/core/hook-loader.js → ../../../../hooks
  // In tests (tsx): services/agent-claw/src/core/hook-loader.ts → ../../../../hooks
  const serviceDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const repoRoot = resolve(serviceDir, "..", "..", "..");
  const dir = hooksDir ?? resolve(repoRoot, "hooks");

  const result: HookLoadResult = {
    filesFound: 0,
    registered: 0,
    skipped: [],
  };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist — no hooks to load. Not an error.
    return result;
  }

  const yamlFiles = entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  result.filesFound = yamlFiles.length;

  // Phase 4 of the configuration concept: parse first, then sort by order
  // so registration is deterministic regardless of filesystem readdir order.
  interface ParsedHook { file: string; hook: HookYaml }
  const parsed: ParsedHook[] = [];

  for (const file of yamlFiles) {
    const filePath = resolve(dir, file);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      result.skipped.push(`${file}: unreadable`);
      continue;
    }

    let yamlParsed: unknown;
    try {
      yamlParsed = parseYaml(raw);
    } catch {
      result.skipped.push(`${file}: YAML parse error`);
      continue;
    }

    if (yamlParsed === null || typeof yamlParsed !== "object") {
      result.skipped.push(`${file}: not an object`);
      continue;
    }
    parsed.push({ file, hook: yamlParsed });
  }

  // Stable sort by order (ascending), then by file name as a tiebreaker so
  // a forgotten `order:` field doesn't yield non-determinism.
  parsed.sort((a, b) => {
    const oa = a.hook.order ?? DEFAULT_HOOK_ORDER;
    const ob = b.hook.order ?? DEFAULT_HOOK_ORDER;
    if (oa !== ob) return oa - ob;
    return a.file.localeCompare(b.file);
  });

  for (const { file, hook } of parsed) {
    if (!hook.name || typeof hook.name !== "string") {
      result.skipped.push(`${file}: missing name`);
      continue;
    }

    if (!hook.lifecycle || !VALID_HOOK_POINTS.has(hook.lifecycle)) {
      result.skipped.push(`${file}: invalid lifecycle "${hook.lifecycle ?? ""}"`);
      continue;
    }

    // explicit-false check: undefined or true means "enabled"; only an
    // explicit `enabled: false` in YAML disables the hook. Don't simplify
    // to `!hook.enabled` — that would treat undefined as disabled too.
    if (hook.enabled !== undefined && !hook.enabled) {
      result.skipped.push(`${file}: disabled`);
      continue;
    }

    // Phase 4 of the configuration concept — runtime condition gate.
    if (hook.condition && !(await evaluateCondition(hook.condition))) {
      result.skipped.push(`${file}: condition false`);
      continue;
    }

    const hookPoint = hook.lifecycle as HookPoint;
    const lifecycleOpts = hook.timeout_ms ? { timeout: hook.timeout_ms } : undefined;

    if (hook.script) {
      // Dynamic import for script-based hooks.
      try {
        const scriptPath = resolve(dir, hook.script);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const module = await import(scriptPath);
        // Convention: the module must export a default async function.
        const def: unknown = (module as { default?: unknown }).default;
        if (typeof def !== "function") {
          result.skipped.push(`${file}: script does not export a default function`);
          continue;
        }
        lifecycle.on(
          hookPoint,
          hook.name,
          def as Parameters<typeof lifecycle.on>[2],
          lifecycleOpts,
        );
        result.registered++;
      } catch (err) {
        result.skipped.push(`${file}: script import failed — ${String(err)}`);
      }
      continue;
    }

    // Built-in hook — look up the registrar.
    const registrar = BUILTIN_REGISTRARS.get(hook.name);
    if (!registrar) {
      result.skipped.push(`${file}: no built-in registrar for "${hook.name}"`);
      continue;
    }

    // Built-in registrars don't currently expose a per-hook timeout knob;
    // if a YAML sets timeout_ms for a built-in, we log it as advisory until
    // the registrars are reworked to accept it (out of scope for Phase 4).
    if (lifecycleOpts) {
      result.skipped.push(
        `${file}: timeout_ms ignored for built-in (advisory; track separately)`,
      );
    }
    registrar(lifecycle, deps);
    result.registered++;
  }

  return result;
}

/**
 * Phase 4 of the configuration concept: evaluate a YAML `condition` block.
 * Resolution order:
 *   1. condition.setting_key — query ConfigRegistry singleton (60s cache).
 *   2. condition.env_var     — read process.env, "true"/"1" → true.
 *   3. condition.default     — use as the final fallback.
 * Any thrown error in the singleton lookup falls through to env_var.
 */
async function evaluateCondition(condition: HookCondition): Promise<boolean> {
  if (condition.setting_key) {
    try {
      const { getConfigRegistry } = await import("../config/registry.js");
      const v = await getConfigRegistry().getBoolean(
        condition.setting_key,
        {},
        condition.default ?? true,
      );
      return v;
    } catch {
      // singleton not initialised in unit tests — fall through
    }
  }
  if (condition.env_var) {
    const raw = process.env[condition.env_var];
    if (raw !== undefined) return raw === "true" || raw === "1";
  }
  return condition.default ?? true;
}
