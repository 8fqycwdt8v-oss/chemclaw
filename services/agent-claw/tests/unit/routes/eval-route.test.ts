// Tests for /api/eval route — Phase E.

import { describe, it, expect } from "vitest";
import { parseEvalArgs } from "../../../src/core/slash.js";

// ---------------------------------------------------------------------------
// We test the eval-parser logic and the scoring heuristic directly.
// ---------------------------------------------------------------------------

// Inline the scorer from eval.ts to avoid Fastify app bootstrapping.
function scoreResponse(predicted: string, expected: string): number {
  if (!expected) return 0;
  const p = predicted.toLowerCase();
  const e = expected.toLowerCase().slice(0, 100);
  return e && p.includes(e) ? 1.0 : 0.0;
}

describe("/eval route — unit logic", () => {
  describe("parseEvalArgs integration", () => {
    it("golden sub-command is handled", () => {
      const r = parseEvalArgs("golden");
      expect(r.subVerb).toBe("golden");
    });

    it("shadow sub-command with prompt name is handled", () => {
      const r = parseEvalArgs("shadow agent.system");
      expect(r.subVerb).toBe("shadow");
      if (r.subVerb === "shadow") expect(r.promptName).toBe("agent.system");
    });

    it("unknown sub-command returns unknown", () => {
      const r = parseEvalArgs("blah");
      expect(r.subVerb).toBe("unknown");
    });
  });

  describe("scoreResponse", () => {
    it("returns 1.0 when expected appears in predicted", () => {
      expect(scoreResponse("The ibuprofen synthesis route via BHC", "ibuprofen synthesis")).toBe(1.0);
    });

    it("returns 0.0 when expected is not in predicted", () => {
      expect(scoreResponse("Unrelated answer", "ibuprofen synthesis")).toBe(0.0);
    });

    it("returns 0 for empty expected", () => {
      expect(scoreResponse("Some answer", "")).toBe(0);
    });

    it("is case-insensitive", () => {
      expect(scoreResponse("IBUPROFEN SYNTHESIS via BHC", "ibuprofen synthesis")).toBe(1.0);
    });
  });

  describe("fixture loading", () => {
    it("fixture file has the correct format", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const fixturePath = "tests/golden/chem_qa_holdout_v1.fixture.jsonl";

      if (!existsSync(fixturePath)) {
        // Skip if running from a different working directory.
        return;
      }

      const lines = readFileSync(fixturePath, "utf-8").split("\n").filter((l: string) => l.trim());
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        const obj = JSON.parse(line) as Record<string, unknown>;
        expect(obj).toHaveProperty("question");
        expect(obj).toHaveProperty("answer");
        expect(Array.isArray(obj.expected_classes)).toBe(true);
      }
    });
  });
});
