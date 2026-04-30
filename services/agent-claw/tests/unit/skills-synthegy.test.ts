// Tests for the on-disk synthegy_retro and synthegy_feasibility skill packs.
// Loads from the real repo skills/ directory (not a tmpdir) so that the
// SKILL.md / prompt.md files ship correctly: frontmatter parses, tool lists
// match expectations, and the paper-compatible <score> output convention is
// preserved in the prompt body.

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "path";
import { SkillLoader } from "../../src/core/skills.js";

const REPO_SKILLS_DIR = resolve(__dirname, "../../../../skills");

describe("synthegy skill packs (on-disk)", () => {
  let loader: SkillLoader;

  beforeAll(() => {
    loader = new SkillLoader();
    loader.load(REPO_SKILLS_DIR);
  });

  describe("synthegy_retro", () => {
    it("loads with the documented frontmatter", () => {
      const skill = loader.get("synthegy_retro");
      expect(skill).toBeDefined();
      expect(skill?.id).toBe("synthegy_retro");
      expect(skill?.version).toBe(1);
      expect(skill?.description).toMatch(/Strategy-aware|natural-language/i);
    });

    it("scopes to the retrosynthesis tools that the agent needs", () => {
      const skill = loader.get("synthegy_retro");
      const tools = skill?.tools ?? [];
      // Strategy-aware retro requires: canonicalization + a way to get candidate
      // routes (propose_retrosynthesis from askcos/aizynth) + portfolio-grounded
      // alternatives (find_similar_reactions) + grounding tools.
      expect(tools).toContain("canonicalize_smiles");
      expect(tools).toContain("propose_retrosynthesis");
      expect(tools).toContain("find_similar_reactions");
      expect(tools).toContain("expand_reaction_context");
      expect(tools).toContain("search_knowledge");
      expect(tools).toContain("query_kg");
    });

    it("preserves the paper-compatible <analysis> + <score> output convention", () => {
      // This is the load-bearing invariant: outputs must use the same XML tags
      // as Synthegy's published prompts so that scores remain comparable to
      // the paper's benchmark and the Zenodo dataset (10.5281/zenodo.19636339).
      const skill = loader.get("synthegy_retro");
      expect(skill?.promptBody).toContain("<analysis>");
      expect(skill?.promptBody).toContain("</analysis>");
      expect(skill?.promptBody).toContain("<score>");
      expect(skill?.promptBody).toContain("</score>");
    });

    it("documents the paper's positional-bias limitation (score routes one at a time)", () => {
      // Another paper-derived invariant: the prompt must instruct the model to
      // score one route at a time, not multiple in one prompt, because Synthegy
      // shows positional bias in multi-candidate prompts (paper Discussion).
      const skill = loader.get("synthegy_retro");
      expect(skill?.promptBody).toMatch(/one at a time|one route at a time|positional/i);
    });

    it("cites the paper so users / auditors can trace the prompt's provenance", () => {
      const skill = loader.get("synthegy_retro");
      expect(skill?.promptBody).toMatch(/10\.1016\/j\.matt\.2026\.102812|Bran et al/);
    });
  });

  describe("synthegy_feasibility", () => {
    it("loads with the documented frontmatter", () => {
      const skill = loader.get("synthegy_feasibility");
      expect(skill).toBeDefined();
      expect(skill?.id).toBe("synthegy_feasibility");
      expect(skill?.version).toBe(1);
      expect(skill?.description).toMatch(/feasibility|yield|side reaction/i);
    });

    it("scopes to feasibility-screening tools (no hypothesis-proposing)", () => {
      const skill = loader.get("synthegy_feasibility");
      const tools = skill?.tools ?? [];
      expect(tools).toContain("canonicalize_smiles");
      expect(tools).toContain("propose_retrosynthesis");
      expect(tools).toContain("expand_reaction_context");
      expect(tools).toContain("search_knowledge");
      expect(tools).toContain("query_kg");
      // Feasibility skill is a screener, not a hypothesis generator. Keeping
      // propose_hypothesis OUT of this skill prevents the agent from claiming
      // mechanistic justifications it can't actually evidence.
      expect(tools).not.toContain("propose_hypothesis");
    });

    it("preserves the paper-compatible <analysis> + <score> output convention", () => {
      const skill = loader.get("synthegy_feasibility");
      expect(skill?.promptBody).toContain("<analysis>");
      expect(skill?.promptBody).toContain("<score>");
    });

    it("warns about the paper's documented optimism bias", () => {
      const skill = loader.get("synthegy_feasibility");
      expect(skill?.promptBody).toMatch(/optimis(m|tic) bias|over-rank/i);
    });
  });

  describe("activation behavior", () => {
    it("filters tools to the synthegy_retro list + always-on baseline when active", () => {
      const r = loader.enable("synthegy_retro");
      expect(r.ok).toBe(true);

      // Stub out the full tool catalog; only the ones in the skill's tools
      // list (plus the always-on baseline) should survive filtering.
      const stubTools = [
        "canonicalize_smiles",
        "propose_retrosynthesis",
        "find_similar_reactions",
        "expand_reaction_context",
        "search_knowledge",
        "query_kg",
        "propose_hypothesis",
        // Tools that should be filtered OUT when only synthegy_retro is active:
        "elucidate_mechanism",
        "predict_reaction_yield",
        "compute_conformer_ensemble",
      ].map((id) => ({
        id,
        description: id,
        execute: async () => ({}),
        // The filterTools call only reads .id, but the rest of the shape keeps
        // TypeScript happy.
      })) as unknown as Array<{ id: string }>;

      const filtered = loader.filterTools(stubTools as any).map((t) => t.id);

      // synthegy_retro tools must be present.
      expect(filtered).toContain("canonicalize_smiles");
      expect(filtered).toContain("propose_retrosynthesis");
      expect(filtered).toContain("find_similar_reactions");
      // Out-of-scope tools must be filtered out.
      expect(filtered).not.toContain("elucidate_mechanism");
      expect(filtered).not.toContain("predict_reaction_yield");
      expect(filtered).not.toContain("compute_conformer_ensemble");

      loader.disable("synthegy_retro");
    });

    it("buildSystemPrompt prepends the synthegy_feasibility prompt body when active", () => {
      loader.enable("synthegy_feasibility");
      const prompt = loader.buildSystemPrompt("BASE_SYSTEM_PROMPT");
      expect(prompt).toContain("## Active skill: synthegy_feasibility");
      expect(prompt).toContain("<score>");
      expect(prompt).toContain("BASE_SYSTEM_PROMPT");
      // Skill prompt comes before base, per the loader's contract.
      expect(prompt.indexOf("## Active skill")).toBeLessThan(
        prompt.indexOf("BASE_SYSTEM_PROMPT"),
      );
      loader.disable("synthegy_feasibility");
    });
  });
});
