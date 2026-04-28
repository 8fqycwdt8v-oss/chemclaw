// YAML hook loader.
//
// Reads hooks/*.yaml at startup (path from env HOOKS_DIR, default <repo-root>/hooks).
// Each YAML defines a hook that gets registered into the Lifecycle dispatcher
// via the BUILTIN_REGISTRARS map. Hooks with a `script` field dynamically
// import the module — supported but no script-based hooks ship today.
//
// As of v1.2.0 this is the single source of truth for hook registration on
// the production startup path. The 9 built-in hooks register here; new hooks
// require both a YAML file in hooks/ AND an entry in BUILTIN_REGISTRARS.
//
// YAML shape:
//   name: <string>
//   lifecycle: pre_turn | pre_tool | post_tool | pre_compact | post_turn
//   enabled: true | false
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

// ---------------------------------------------------------------------------
// YAML schema (validated at load time).
// ---------------------------------------------------------------------------

const VALID_HOOK_POINTS = new Set<string>([
  "pre_turn",
  "pre_tool",
  "post_tool",
  "pre_compact",
  "post_turn",
]);

interface HookYaml {
  name: string;
  lifecycle: string;
  enabled: boolean;
  script?: string;
  definition?: Record<string, unknown>;
}

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

const BUILTIN_REGISTRARS: Map<string, BuiltinRegistrar> = new Map([
  ["redact-secrets", (lc) => registerRedactSecretsHook(lc)],
  ["tag-maturity", (lc) => registerTagMaturityHook(lc)],
  ["budget-guard", (lc) => registerBudgetGuardHook(lc)],
  ["init-scratch", (lc) => registerInitScratchHook(lc)],
  ["anti-fabrication", (lc) => registerAntiFabricationHook(lc)],
  ["foundation-citation-guard", (lc) => registerFoundationCitationGuardHook(lc)],
  ["source-cache", (lc, deps) => registerSourceCacheHook(lc, deps.pool)],
  [
    "compact-window",
    (lc, deps) =>
      registerCompactWindowHook(lc, {
        llm: deps.llm,
        tokenBudget: deps.tokenBudget,
      }),
  ],
  [
    "apply-skills",
    (lc, deps) => registerApplySkillsHook(lc, deps.skillLoader, deps.allTools),
  ],
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

  for (const file of yamlFiles) {
    const filePath = resolve(dir, file);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      result.skipped.push(`${file}: unreadable`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      result.skipped.push(`${file}: YAML parse error`);
      continue;
    }

    const hook = parsed as HookYaml;

    if (!hook || typeof hook !== "object") {
      result.skipped.push(`${file}: not an object`);
      continue;
    }

    if (!hook.name || typeof hook.name !== "string") {
      result.skipped.push(`${file}: missing name`);
      continue;
    }

    if (!hook.lifecycle || !VALID_HOOK_POINTS.has(hook.lifecycle)) {
      result.skipped.push(`${file}: invalid lifecycle "${hook.lifecycle}"`);
      continue;
    }

    if (hook.enabled === false) {
      result.skipped.push(`${file}: disabled`);
      continue;
    }

    const hookPoint = hook.lifecycle as HookPoint;

    if (hook.script) {
      // Dynamic import for script-based hooks.
      try {
        const scriptPath = resolve(dir, hook.script);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const module = await import(scriptPath);
        // Convention: the module must export a default async function.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (typeof module.default !== "function") {
          result.skipped.push(`${file}: script does not export a default function`);
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        lifecycle.on(hookPoint, hook.name, module.default);
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

    registrar(lifecycle, deps);
    result.registered++;
  }

  return result;
}
