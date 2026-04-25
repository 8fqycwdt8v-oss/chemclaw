// Skill-pack loader + per-turn activation.
//
// Scans skills/*/SKILL.md at startup, parses YAML frontmatter, validates schema.
// Maintains an activeSkills set per session (modified via /skills enable|disable).
// Provides helpers used by the apply-skills pre_turn hook to:
//   - prepend active skills' prompt.md bodies to the system prompt.
//   - filter the tool catalog to the union of active skills' tools + always-on baseline.
//
// If no skills are active, all registered tools remain available (current default).

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import yaml from "js-yaml";
import type { Tool } from "../tools/tool.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  id: string;
  description: string;
  version: number;
  tools: string[];
  max_steps_override?: number;
}

export interface Skill {
  id: string;
  description: string;
  version: number;
  tools: string[];
  max_steps_override?: number;
  /** Raw body of prompt.md (without frontmatter). */
  promptBody: string;
}

// ---------------------------------------------------------------------------
// Always-on tools — available even when skills filter the catalog.
// ---------------------------------------------------------------------------

const ALWAYS_ON_TOOLS = new Set<string>([
  "canonicalize_smiles",
  "fetch_original_document",
]);

// Max simultaneously active skills (context management).
const MAX_ACTIVE_SKILLS = 8;

// ---------------------------------------------------------------------------
// Frontmatter parser — splits "---\n<yaml>\n---\n<body>" documents.
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const parts = raw.split(/^---\s*$/m);
  // Expected: ["", "<yaml>", "<body>"] or parts[1] = yaml, parts[2+] = body.
  if (parts.length < 3) {
    throw new Error("SKILL.md must have YAML frontmatter delimited by '---'");
  }
  const yamlText = parts[1] ?? "";
  const body = parts.slice(2).join("---").trim();

  const raw_fm = yaml.load(yamlText) as Partial<SkillFrontmatter>;
  if (!raw_fm || typeof raw_fm !== "object") {
    throw new Error("SKILL.md frontmatter must be a YAML object");
  }

  // Validate required fields.
  if (typeof raw_fm.id !== "string" || raw_fm.id.trim() === "") {
    throw new Error("SKILL.md frontmatter missing required field: id");
  }
  if (typeof raw_fm.description !== "string" || raw_fm.description.trim() === "") {
    throw new Error("SKILL.md frontmatter missing required field: description");
  }
  if (typeof raw_fm.version !== "number") {
    throw new Error("SKILL.md frontmatter missing required field: version (number)");
  }
  if (!Array.isArray(raw_fm.tools)) {
    throw new Error("SKILL.md frontmatter missing required field: tools (array)");
  }

  const fm: SkillFrontmatter = {
    id: raw_fm.id.trim(),
    description: raw_fm.description.trim(),
    version: raw_fm.version,
    tools: raw_fm.tools.map(String),
    max_steps_override: raw_fm.max_steps_override,
  };

  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// SkillLoader — loads and manages skill packs.
// ---------------------------------------------------------------------------

export class SkillLoader {
  private readonly _skills: Map<string, Skill> = new Map();
  /** Per-session active skill IDs. */
  private readonly _active: Set<string> = new Set();

  /**
   * Load all skill packs from the given directory (default: skills/ at repo root).
   * Skips _template/ and any directory without a SKILL.md.
   * Throws on malformed frontmatter so CI catches broken skills early.
   */
  load(skillsDir?: string): void {
    const dir = skillsDir ?? resolve(process.cwd(), "skills");
    if (!existsSync(dir)) {
      // No skills dir — silent skip (service still works without skills).
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
        .map((e) => e.name as string);
    } catch {
      return;
    }

    for (const name of entries) {
      const skillMdPath = join(dir, name, "SKILL.md");
      const promptMdPath = join(dir, name, "prompt.md");
      if (!existsSync(skillMdPath)) continue;

      const raw = readFileSync(skillMdPath, "utf8");
      const { frontmatter, body: bodyFromSkillMd } = parseFrontmatter(raw);

      // prompt.md is the canonical invocation framing; fall back to SKILL.md body.
      let promptBody = bodyFromSkillMd;
      if (existsSync(promptMdPath)) {
        promptBody = readFileSync(promptMdPath, "utf8").trim();
      }

      const skill: Skill = {
        id: frontmatter.id,
        description: frontmatter.description,
        version: frontmatter.version,
        tools: frontmatter.tools,
        max_steps_override: frontmatter.max_steps_override,
        promptBody,
      };

      this._skills.set(skill.id, skill);
    }
  }

  // --------------------------------------------------------------------------
  // Active-set management
  // --------------------------------------------------------------------------

  /** Enable a skill by ID. Returns false if not found or cap reached. */
  enable(id: string): { ok: boolean; reason?: string } {
    if (!this._skills.has(id)) {
      return { ok: false, reason: `skill '${id}' not found` };
    }
    if (this._active.size >= MAX_ACTIVE_SKILLS && !this._active.has(id)) {
      return {
        ok: false,
        reason: `cannot activate more than ${MAX_ACTIVE_SKILLS} skills simultaneously`,
      };
    }
    this._active.add(id);
    return { ok: true };
  }

  /** Disable a skill by ID. Returns false if not found. */
  disable(id: string): { ok: boolean; reason?: string } {
    if (!this._active.has(id)) {
      return { ok: false, reason: `skill '${id}' is not active` };
    }
    this._active.delete(id);
    return { ok: true };
  }

  /** Enable a skill for a single turn only (does not persist). Returns a cleanup fn. */
  enableForTurn(id: string): () => void {
    const wasActive = this._active.has(id);
    if (!wasActive) this._active.add(id);
    return () => {
      if (!wasActive) this._active.delete(id);
    };
  }

  /** All registered skills (for /skills list). */
  list(): Array<Skill & { active: boolean }> {
    return [...this._skills.values()].map((s) => ({
      ...s,
      active: this._active.has(s.id),
    }));
  }

  /** True if a skill with this ID is registered. */
  has(id: string): boolean {
    return this._skills.has(id);
  }

  /** Get a skill by ID. */
  get(id: string): Skill | undefined {
    return this._skills.get(id);
  }

  /** Currently active skill IDs. */
  get activeIds(): ReadonlySet<string> {
    return this._active;
  }

  /** Number of loaded skills. */
  get size(): number {
    return this._skills.size;
  }

  // --------------------------------------------------------------------------
  // System-prompt injection
  // --------------------------------------------------------------------------

  /**
   * Prepend active skills' prompt.md bodies to a system prompt string.
   * Each skill block is headed with "## Active skill: <id>".
   */
  buildSystemPrompt(basePrompt: string): string {
    const activeBodies: string[] = [];
    for (const id of this._active) {
      const skill = this._skills.get(id);
      if (skill?.promptBody) {
        activeBodies.push(`## Active skill: ${id}\n\n${skill.promptBody}`);
      }
    }
    if (activeBodies.length === 0) return basePrompt;
    return activeBodies.join("\n\n") + "\n\n" + basePrompt;
  }

  // --------------------------------------------------------------------------
  // Tool filtering
  // --------------------------------------------------------------------------

  /**
   * Filter the tool catalog for the current active-skill set.
   *
   * - If no skills are active: returns all tools (current default behavior).
   * - If ≥1 skill is active: returns the union of tools from all active skills
   *   plus the always-on baseline (ALWAYS_ON_TOOLS).
   */
  filterTools(allTools: Tool[]): Tool[] {
    if (this._active.size === 0) return allTools;

    const allowed = new Set<string>([...ALWAYS_ON_TOOLS]);
    for (const id of this._active) {
      const skill = this._skills.get(id);
      if (skill) {
        for (const t of skill.tools) allowed.add(t);
      }
    }

    return allTools.filter((t) => allowed.has(t.id));
  }

  /**
   * Return the effective max_steps_override for the active skill set.
   * Returns the maximum override across all active skills, or undefined
   * if no active skill declares an override.
   */
  maxStepsOverride(): number | undefined {
    let max: number | undefined;
    for (const id of this._active) {
      const skill = this._skills.get(id);
      if (skill?.max_steps_override !== undefined) {
        max = max === undefined ? skill.max_steps_override : Math.max(max, skill.max_steps_override);
      }
    }
    return max;
  }
}

// ---------------------------------------------------------------------------
// Singleton loader (shared across the process).
// ---------------------------------------------------------------------------

let _singleton: SkillLoader | undefined;

export function getSkillLoader(): SkillLoader {
  if (!_singleton) {
    _singleton = new SkillLoader();
    _singleton.load();
  }
  return _singleton;
}

/** Reset the singleton (test use only). */
export function _resetSkillLoader(): void {
  _singleton = undefined;
}

// ---------------------------------------------------------------------------
// Slash verb → skill mapping
// ---------------------------------------------------------------------------

export const VERB_TO_SKILL: Record<string, string> = {
  dr: "deep_research",
  retro: "retro",
  qc: "qc",
};
