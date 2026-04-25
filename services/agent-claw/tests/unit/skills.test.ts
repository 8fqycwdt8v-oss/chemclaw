// Tests for the SkillLoader: load, activate/deactivate, tool filtering, prompt injection.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SkillLoader } from "../../src/core/skills.js";
import { defineTool } from "../../src/tools/tool.js";
import { z } from "zod";

// Helpers to create a temporary skills directory.
function makeTmpSkillsDir(): string {
  return mkdtempSync(join(tmpdir(), "chemclaw-skills-test-"));
}

function writeSkill(
  dir: string,
  id: string,
  extra: Record<string, unknown> = {},
  toolsList: string[] = ["tool_a"],
): void {
  const skillDir = join(dir, id);
  mkdirSync(skillDir, { recursive: true });
  const fm = {
    id,
    description: `Test skill ${id}`,
    version: 1,
    tools: toolsList,
    ...extra,
  };
  const fmYaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\n${fmYaml}\n---\n\n# Body of ${id}\n`,
  );
  writeFileSync(
    join(skillDir, "prompt.md"),
    `## Active skill: ${id}\n\nPrompt body for ${id}.`,
  );
}

// Stub tools.
const toolA = defineTool({
  id: "tool_a",
  description: "stub a",
  inputSchema: z.object({ x: z.string() }),
  outputSchema: z.object({ y: z.string() }),
  execute: async (_ctx, { x }) => ({ y: x }),
});

const toolB = defineTool({
  id: "tool_b",
  description: "stub b",
  inputSchema: z.object({ x: z.string() }),
  outputSchema: z.object({ y: z.string() }),
  execute: async (_ctx, { x }) => ({ y: x }),
});

const canonicalize = defineTool({
  id: "canonicalize_smiles",
  description: "always on",
  inputSchema: z.object({ smiles: z.string() }),
  outputSchema: z.object({ canonical: z.string() }),
  execute: async () => ({ canonical: "CCO" }),
});

const allTools = [toolA, toolB, canonicalize];

describe("SkillLoader — load", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpSkillsDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads skill packs from a directory", () => {
    writeSkill(dir, "retro");
    writeSkill(dir, "qc", {}, ["tool_b"]);
    const loader = new SkillLoader();
    loader.load(dir);
    expect(loader.size).toBe(2);
  });

  it("skips directories starting with _", () => {
    writeSkill(dir, "_template");
    writeSkill(dir, "retro");
    const loader = new SkillLoader();
    loader.load(dir);
    expect(loader.size).toBe(1);
  });

  it("reads prompt.md when present", () => {
    writeSkill(dir, "retro");
    const loader = new SkillLoader();
    loader.load(dir);
    const skill = loader.get("retro");
    expect(skill?.promptBody).toContain("Prompt body for retro");
  });

  it("parses max_steps_override from frontmatter", () => {
    writeSkill(dir, "dr", { max_steps_override: 40 });
    const loader = new SkillLoader();
    loader.load(dir);
    expect(loader.get("dr")?.max_steps_override).toBe(40);
  });

  it("returns an empty list when skills/ does not exist", () => {
    const loader = new SkillLoader();
    loader.load("/nonexistent/path/that/does/not/exist");
    expect(loader.size).toBe(0);
  });
});

describe("SkillLoader — enable/disable", () => {
  let dir: string;
  let loader: SkillLoader;

  beforeEach(() => {
    dir = makeTmpSkillsDir();
    writeSkill(dir, "retro");
    writeSkill(dir, "qc");
    loader = new SkillLoader();
    loader.load(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("enables a known skill", () => {
    const r = loader.enable("retro");
    expect(r.ok).toBe(true);
    expect(loader.activeIds.has("retro")).toBe(true);
  });

  it("disables an active skill", () => {
    loader.enable("retro");
    const r = loader.disable("retro");
    expect(r.ok).toBe(true);
    expect(loader.activeIds.has("retro")).toBe(false);
  });

  it("returns ok=false when enabling unknown skill", () => {
    const r = loader.enable("nonexistent");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  it("returns ok=false when disabling inactive skill", () => {
    const r = loader.disable("retro");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not active/);
  });

  it("enableForTurn activates for the turn then reverts", () => {
    expect(loader.activeIds.has("retro")).toBe(false);
    const cleanup = loader.enableForTurn("retro");
    expect(loader.activeIds.has("retro")).toBe(true);
    cleanup();
    expect(loader.activeIds.has("retro")).toBe(false);
  });

  it("enableForTurn does not disable a pre-existing active skill on cleanup", () => {
    loader.enable("retro"); // persistently active
    const cleanup = loader.enableForTurn("retro");
    cleanup();
    // Should still be active because it was active before enableForTurn.
    expect(loader.activeIds.has("retro")).toBe(true);
  });
});

describe("SkillLoader — tool filtering", () => {
  let dir: string;
  let loader: SkillLoader;

  beforeEach(() => {
    dir = makeTmpSkillsDir();
    writeSkill(dir, "retro", {}, ["tool_a", "canonicalize_smiles"]);
    writeSkill(dir, "qc", {}, ["tool_b"]);
    loader = new SkillLoader();
    loader.load(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns all tools when no skills are active", () => {
    const filtered = loader.filterTools(allTools);
    expect(filtered.length).toBe(allTools.length);
  });

  it("filters to skill tools + always-on baseline when a skill is active", () => {
    loader.enable("retro");
    const filtered = loader.filterTools(allTools);
    const ids = filtered.map((t) => t.id);
    expect(ids).toContain("tool_a");
    expect(ids).toContain("canonicalize_smiles");
    expect(ids).not.toContain("tool_b");
  });

  it("unions tools across multiple active skills", () => {
    loader.enable("retro");
    loader.enable("qc");
    const filtered = loader.filterTools(allTools);
    const ids = filtered.map((t) => t.id);
    expect(ids).toContain("tool_a");
    expect(ids).toContain("tool_b");
    expect(ids).toContain("canonicalize_smiles");
  });
});

describe("SkillLoader — system prompt injection", () => {
  let dir: string;
  let loader: SkillLoader;

  beforeEach(() => {
    dir = makeTmpSkillsDir();
    writeSkill(dir, "retro");
    loader = new SkillLoader();
    loader.load(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns base prompt unchanged when no skills are active", () => {
    const base = "Base system prompt.";
    expect(loader.buildSystemPrompt(base)).toBe(base);
  });

  it("prepends active skill prompt with heading", () => {
    loader.enable("retro");
    const result = loader.buildSystemPrompt("Base prompt.");
    expect(result).toContain("## Active skill: retro");
    expect(result).toContain("Prompt body for retro");
    expect(result).toContain("Base prompt.");
    // Skill prompt comes before base.
    expect(result.indexOf("## Active skill")).toBeLessThan(result.indexOf("Base prompt."));
  });
});
