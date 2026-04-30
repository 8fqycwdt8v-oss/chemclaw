// Tests for GET /api/skills/list and POST /api/skills/enable|disable endpoints.

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import type { Pool } from "pg";
import { registerSkillsRoutes } from "../../src/routes/skills.js";
import { SkillLoader } from "../../src/core/skills.js";
import { createMockPool } from "../helpers/mock-pool.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeTmpSkillsDir(): string {
  return mkdtempSync(join(tmpdir(), "chemclaw-api-skills-"));
}

function writeSkill(dir: string, id: string, tools: string[] = ["search_knowledge"]): void {
  const skillDir = join(dir, id);
  mkdirSync(skillDir, { recursive: true });
  const fm = `id: "${id}"\ndescription: "Test ${id}"\nversion: 1\ntools: ${JSON.stringify(tools)}\n`;
  writeFileSync(join(skillDir, "SKILL.md"), `---\n${fm}---\n\n# Body\n`);
  writeFileSync(join(skillDir, "prompt.md"), `## Active skill: ${id}\n\nPrompt.`);
}

// Mock pool that always reports the test user as having admin role.
function buildAdminPool(): Pool {
  const { pool } = createMockPool({
    dataHandler: async (sql) => {
      if (sql.includes("user_project_access") && sql.includes("admin")) {
        return { rows: [{ has_admin: true }], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
  });
  return pool;
}

async function buildApp(loader: SkillLoader) {
  const app = Fastify({ logger: false });
  registerSkillsRoutes(app, {
    loader,
    pool: buildAdminPool(),
    getUser: () => "test@local.test",
  });
  await app.ready();
  return await app;
}

describe("GET /api/skills/list", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpSkillsDir();
  });

  it("returns an empty skills array when no skills are loaded", async () => {
    const loader = new SkillLoader();
    const app = await buildApp(loader);
    const resp = await app.inject({ method: "GET", url: "/api/skills/list" });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills.length).toBe(0);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns loaded skills with active=false by default", async () => {
    writeSkill(dir, "retro", ["find_similar_reactions"]);
    writeSkill(dir, "qc", ["analyze_csv"]);
    const loader = new SkillLoader();
    loader.load(dir);
    const app = await buildApp(loader);

    const resp = await app.inject({ method: "GET", url: "/api/skills/list" });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.skills.length).toBe(2);
    for (const s of body.skills) {
      expect(s.active).toBe(false);
      expect(typeof s.id).toBe("string");
      expect(typeof s.description).toBe("string");
    }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows active=true after enabling a skill", async () => {
    writeSkill(dir, "retro");
    const loader = new SkillLoader();
    loader.load(dir);
    loader.enable("retro");
    const app = await buildApp(loader);

    const resp = await app.inject({ method: "GET", url: "/api/skills/list" });
    const body = JSON.parse(resp.body);
    const retro = body.skills.find((s: { id: string }) => s.id === "retro");
    expect(retro?.active).toBe(true);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("POST /api/skills/enable + /api/skills/disable", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpSkillsDir();
  });

  it("enables a known skill and returns active list", async () => {
    writeSkill(dir, "retro");
    const loader = new SkillLoader();
    loader.load(dir);
    const app = await buildApp(loader);

    const resp = await app.inject({
      method: "POST",
      url: "/api/skills/enable",
      payload: JSON.stringify({ id: "retro" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.ok).toBe(true);
    expect(body.active).toContain("retro");
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 400 when enabling an unknown skill", async () => {
    const loader = new SkillLoader();
    const app = await buildApp(loader);

    const resp = await app.inject({
      method: "POST",
      url: "/api/skills/enable",
      payload: JSON.stringify({ id: "nonexistent" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.statusCode).toBe(400);
    await app.close();
  });

  it("disables an active skill", async () => {
    writeSkill(dir, "qc");
    const loader = new SkillLoader();
    loader.load(dir);
    loader.enable("qc");
    const app = await buildApp(loader);

    const resp = await app.inject({
      method: "POST",
      url: "/api/skills/disable",
      payload: JSON.stringify({ id: "qc" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.ok).toBe(true);
    expect(body.active).not.toContain("qc");
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
