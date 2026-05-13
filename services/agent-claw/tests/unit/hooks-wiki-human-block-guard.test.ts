// Tests for the wiki-human-block-guard pre_tool hook (ADR 012 Phase 1).

import { describe, it, expect } from "vitest";

import { wikiHumanBlockGuardHook } from "../../src/core/hooks/wiki-human-block-guard.js";
import type { PreToolPayload } from "../../src/core/types.js";
import { makeCtx } from "../helpers/make-ctx.js";

function payload(toolId: string, input: unknown): PreToolPayload {
  return { ctx: makeCtx(), toolId, input };
}

const NOOP = {} as const;

describe("wiki-human-block-guard", () => {
  it("ignores tools other than upsert_article", async () => {
    const out = await wikiHumanBlockGuardHook(
      payload("upsert_synthesis_campaign", { body_md: "<!-- human:begin -->x<!-- human:end -->" }),
    );
    expect(out).toEqual(NOOP);
  });

  it("allows an upsert_article body with no human marker", async () => {
    const out = await wikiHumanBlockGuardHook(
      payload("upsert_article", { body_md: "A perfectly ordinary page body. [fact:abc]" }),
    );
    expect(out).toEqual(NOOP);
  });

  it("denies an upsert_article body containing a human:begin marker", async () => {
    const out = await wikiHumanBlockGuardHook(
      payload("upsert_article", {
        body_md: "intro\n<!-- human:begin owner=alice@x.com name=caveat -->trusted text<!-- human:end -->\noutro",
      }),
    );
    expect("hookSpecificOutput" in out && out.hookSpecificOutput).toBeTruthy();
    if ("hookSpecificOutput" in out) {
      expect(out.hookSpecificOutput).toMatchObject({
        hookEventName: "pre_tool",
        permissionDecision: "deny",
      });
      expect(String((out.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason)).toMatch(
        /human:begin|request_article/,
      );
    }
  });

  it("is case-insensitive and tolerates whitespace in the marker", async () => {
    const out = await wikiHumanBlockGuardHook(
      payload("upsert_article", { body_md: "<!--   HUMAN:BEGIN  owner=bob -->y<!-- human:end -->" }),
    );
    expect("hookSpecificOutput" in out).toBe(true);
  });

  it("no-ops when input is not an object or has no body_md", async () => {
    expect(await wikiHumanBlockGuardHook(payload("upsert_article", null))).toEqual(NOOP);
    expect(await wikiHumanBlockGuardHook(payload("upsert_article", "string"))).toEqual(NOOP);
    expect(await wikiHumanBlockGuardHook(payload("upsert_article", { title: "no body" }))).toEqual(NOOP);
    expect(await wikiHumanBlockGuardHook(payload("upsert_article", { body_md: 42 }))).toEqual(NOOP);
  });
});
