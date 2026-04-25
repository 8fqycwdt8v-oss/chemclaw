// YAML hook loader.
//
// Reads hooks/*.yaml at startup (path from env HOOKS_DIR, default <repo-root>/hooks).
// Each YAML defines a hook that gets registered into the Lifecycle dispatcher.
//
// YAML shape:
//   name: <string>
//   lifecycle: pre_turn | pre_tool | post_tool | pre_compact | post_turn
//   enabled: true | false
//   script: <optional JS file path relative to this service>
//   definition:
//     <hook-type-specific fields>
//
// Built-in hooks are identified by name and registered from the compiled
// TypeScript modules. Hooks with a `script` field dynamically import the
// module — supported but no script-based hooks ship in Phase A.3.

import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import type { Lifecycle } from "./lifecycle.js";
import type { HookPoint } from "./types.js";
import { registerRedactSecretsHook } from "./hooks/redact-secrets.js";
import { registerTagMaturityHook } from "./hooks/tag-maturity.js";
import { registerBudgetGuardHook } from "./hooks/budget-guard.js";

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
// Built-in registrar map — keyed by hook name.
// ---------------------------------------------------------------------------

type BuiltinRegistrar = (lifecycle: Lifecycle) => void;

const BUILTIN_REGISTRARS: Map<string, BuiltinRegistrar> = new Map([
  ["redact-secrets", registerRedactSecretsHook],
  ["tag-maturity", registerTagMaturityHook],
  ["budget-guard", registerBudgetGuardHook],
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
 * @param hooksDir   Directory containing *.yaml files. Defaults to <repo-root>/hooks.
 */
export async function loadHooks(
  lifecycle: Lifecycle,
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

    registrar(lifecycle);
    result.registered++;
  }

  return result;
}
