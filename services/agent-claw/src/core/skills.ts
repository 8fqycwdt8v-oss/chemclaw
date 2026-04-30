// Skill-pack loader + per-turn activation.
//
// Scans skills/*/SKILL.md at startup, parses YAML frontmatter, validates schema.
// Maintains an activeSkills set per session (modified via /skills enable|disable).
// Provides helpers used by the apply-skills pre_turn hook to:
//   - prepend active skills' prompt.md bodies to the system prompt.
//   - filter the tool catalog to the union of active skills' tools + always-on baseline.
//
// Phase C: also loads DB-backed skills from skill_library WHERE active=true.
// Priority: filesystem skills ALWAYS win. DB skills with a conflicting name+version
// are hidden and logged.
//
// If no skills are active, all registered tools remain available (current default).

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import yaml from "js-yaml";
import type { Pool } from "pg";
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
//
// Default lives here so the loader works without the config_settings table
// (which wasn't created until Phase 2 of the configuration concept). The
// effective limit is read at enable() time via getEffectiveMaxActiveSkills,
// which consults config_settings (key 'agent.max_active_skills') and falls
// back to this value when no row exists.
const DEFAULT_MAX_ACTIVE_SKILLS = 8;

/**
 * Resolve the effective MAX_ACTIVE_SKILLS limit for the current scope.
 *
 * Read order: config_settings(key='agent.max_active_skills') → constant
 * default. The ConfigRegistry singleton may not be initialised in unit
 * tests, so a missing singleton silently returns the default.
 */
async function getEffectiveMaxActiveSkills(): Promise<number> {
  try {
    const { getConfigRegistry } = await import("../config/registry.js");
    const reg = getConfigRegistry();
    const v = await reg.getNumber("agent.max_active_skills", {}, DEFAULT_MAX_ACTIVE_SKILLS);
    // Hard upper-bound to prevent absurd values from breaking context budgeting.
    return Math.max(1, Math.min(50, Math.trunc(v)));
  } catch {
    return DEFAULT_MAX_ACTIVE_SKILLS;
  }
}

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

  const parsed: unknown = yaml.load(yamlText);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("SKILL.md frontmatter must be a YAML object");
  }
  const raw_fm = parsed as Partial<SkillFrontmatter>;

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
  private readonly _skills = new Map<string, Skill>();
  /** Per-session active skill IDs. */
  private readonly _active = new Set<string>();

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
        .map((e) => e.name);
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
    if (this._active.size >= this._activeCap && !this._active.has(id)) {
      return {
        ok: false,
        reason: `cannot activate more than ${this._activeCap} skills simultaneously`,
      };
    }
    this._active.add(id);
    return { ok: true };
  }

  /**
   * In-memory snapshot of the active-skills cap. Updated by
   * refreshLimits() (called from the apply-skills hook on a TTL) so
   * config_settings(key='agent.max_active_skills') wins without making
   * enable() async.
   */
  private _activeCap: number = DEFAULT_MAX_ACTIVE_SKILLS;
  private _capLastRefreshedAt = 0;
  private static readonly _CAP_TTL_MS = 60_000;

  /**
   * Refresh limits from config_settings. Cheap, async, idempotent — call
   * before any enable() that might bump up against the cap. Honours the
   * 60s TTL to avoid hot-loop DB hits.
   */
  async refreshLimits(): Promise<void> {
    const now = Date.now();
    if (now - this._capLastRefreshedAt < SkillLoader._CAP_TTL_MS) return;
    this._capLastRefreshedAt = now;
    this._activeCap = await getEffectiveMaxActiveSkills();
  }

  /** Test hook — force the cap snapshot. */
  setActiveSkillsCapForTesting(cap: number): void {
    this._activeCap = cap;
    this._capLastRefreshedAt = Date.now();
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
   * Load active skills from the skill_library DB table (Phase C.3).
   *
   * Rules:
   *   - Only rows WHERE active=true are loaded.
   *   - Filesystem skills (from load()) ALWAYS win: if a DB skill has the same
   *     `name` as a filesystem skill, the DB skill is silently skipped.
   *   - kind='forged_tool' rows are loaded but have no tools list (Phase D fills them).
   *
   * Non-fatal: DB errors are caught and logged; the in-process skill catalog
   * continues to function with filesystem skills only.
   */
  async loadFromDb(pool: Pool): Promise<{ loaded: number; hidden: number }> {
    let rows: Array<{
      id: string;
      name: string;
      prompt_md: string;
      kind: string;
      version: number;
    }>;

    try {
      // skill_library is a globally-shared catalog. With FORCE RLS the policy
      // requires a non-empty user context — withSystemContext supplies the
      // sentinel without mixing in any specific user's identity.
      const { withSystemContext } = await import("../db/with-user-context.js");
      const result = await withSystemContext(pool, (client) =>
        client.query<{
          id: string;
          name: string;
          prompt_md: string;
          kind: string;
          version: number;
        }>(
          `SELECT id::text AS id, name, prompt_md, kind, version
             FROM skill_library
            WHERE active = true
            ORDER BY name, version DESC`,
        ),
      );
      rows = result.rows;
    } catch {
      // DB unavailable — silently return; filesystem skills still work.
      return { loaded: 0, hidden: 0 };
    }

    let loaded = 0;
    let hidden = 0;

    for (const row of rows) {
      // Sanitize name: lowercase, replace non-alphanumeric with underscore.
      const safeId = row.name.toLowerCase().replace(/[^a-z0-9_]/g, "_");

      // Filesystem skills win: skip if already registered under this id.
      if (this._skills.has(safeId)) {
        hidden++;
        continue;
      }

      const skill: Skill = {
        id: safeId,
        description: `DB-backed skill: ${row.name} (v${row.version})`,
        version: row.version,
        tools: [], // DB skills don't restrict tools unless Phase D sets scripts_path
        promptBody: row.prompt_md,
      };

      this._skills.set(safeId, skill);
      loaded++;
    }

    return { loaded, hidden };
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
// Slash verb → skill mapping
// ---------------------------------------------------------------------------

export const VERB_TO_SKILL: Record<string, string> = {
  dr: "deep_research",
  retro: "retro",
  qc: "qc",
};
