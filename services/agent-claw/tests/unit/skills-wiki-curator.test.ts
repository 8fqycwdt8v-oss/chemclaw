// Sanity tests for the on-disk wiki_curator skill pack (ADR 012 Phase 4b-i).
// Activated by `/wiki <query>` via VERB_TO_SKILL.

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "path";
import { SkillLoader, VERB_TO_SKILL } from "../../src/core/skills.js";

const REPO_SKILLS_DIR = resolve(__dirname, "../../../../skills");

describe("wiki_curator skill pack (on-disk)", () => {
  let loader: SkillLoader;

  beforeAll(() => {
    loader = new SkillLoader();
    loader.load(REPO_SKILLS_DIR);
  });

  it("loads with the documented frontmatter", () => {
    const skill = loader.get("wiki_curator");
    expect(skill).toBeDefined();
    expect(skill?.id).toBe("wiki_curator");
    expect(skill?.version).toBe(1);
    expect(skill?.description).toMatch(/wiki|curator|page/i);
  });

  it("scopes to the wiki + retrieval tools that the agent needs", () => {
    const skill = loader.get("wiki_curator");
    const tools = skill?.tools ?? [];
    // Wiki primitives.
    expect(tools).toContain("list_articles");
    expect(tools).toContain("read_article");
    expect(tools).toContain("upsert_article");
    expect(tools).toContain("request_article");
    // Retrieval used to gather the facts a new page needs.
    expect(tools).toContain("search_knowledge");
    expect(tools).toContain("query_kg");
  });

  it("/wiki maps to the wiki_curator skill", () => {
    expect(VERB_TO_SKILL.wiki).toBe("wiki_curator");
  });

  it("documents the hard rules (no entity pages, no human blocks)", () => {
    const skill = loader.get("wiki_curator");
    // The pre_tool wiki-human-block-guard rejects upsert_article bodies
    // containing <!-- human:begin --> markers — the skill must warn the
    // agent not to author them.
    expect(skill?.promptBody).toMatch(/human:begin|human block|human-edit/i);
    // Entity-backed pages belong to the wiki_regen daemon, not the agent.
    expect(skill?.promptBody).toMatch(/entity-backed|wiki_regen|request_article/i);
  });
});
