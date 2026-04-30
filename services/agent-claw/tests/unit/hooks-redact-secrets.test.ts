// Tests for the redact-secrets post_turn hook.

import { describe, it, expect } from "vitest";
import {
  redactString,
  redactSecretsHook,
  registerRedactSecretsHook,
} from "../../src/core/hooks/redact-secrets.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import type { PostTurnPayload } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// redactString unit tests — pattern matching
// ---------------------------------------------------------------------------

describe("redactString — pattern matching", () => {
  it("redacts an NCE project ID", () => {
    const replacements: Array<{ pattern: string; original: string }> = [];
    const result = redactString("The project NCE-123456 needs review.", replacements);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("NCE-123456");
    expect(replacements.some((r) => r.pattern === "NCE")).toBe(true);
  });

  it("redacts a CMP compound code", () => {
    const replacements: Array<{ pattern: string; original: string }> = [];
    const result = redactString("Compound CMP-12345678 was tested.", replacements);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("CMP-12345678");
    expect(replacements.some((r) => r.pattern === "CMP")).toBe(true);
  });

  it("redacts an email address", () => {
    const replacements: Array<{ pattern: string; original: string }> = [];
    const result = redactString("Contact user@example.com for details.", replacements);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("user@example.com");
    expect(replacements.some((r) => r.pattern === "EMAIL")).toBe(true);
  });

  it("does not redact benign plain text", () => {
    const replacements: Array<{ pattern: string; original: string }> = [];
    const result = redactString("Yield was 85% for the amide coupling reaction.", replacements);
    expect(result).toBe("Yield was 85% for the amide coupling reaction.");
    expect(replacements).toHaveLength(0);
  });

  it("does not redact benign short alphanumeric strings", () => {
    const replacements: Array<{ pattern: string; original: string }> = [];
    const result = redactString("The pH was 7.4 and temperature 25C.", replacements);
    expect(result).not.toContain("[REDACTED]");
    expect(replacements).toHaveLength(0);
  });

  it("redacts a reaction SMILES", () => {
    const replacements: Array<{ pattern: string; original: string }> = [];
    const rxnSmiles = "CC(=O)Cl.NCCN>>CC(=O)NCCN";
    const result = redactString(`Reaction: ${rxnSmiles}`, replacements);
    expect(result).not.toContain("CC(=O)Cl");
    expect(replacements.some((r) => r.pattern === "RXN_SMILES")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// post_turn hook — finalText mutation
// ---------------------------------------------------------------------------

function makePostTurnPayload(finalText: string): PostTurnPayload {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return {
    ctx: {
      userEntraId: "test@example.com",
      scratchpad,
      seenFactIds,
    },
    finalText,
    stepsUsed: 1,
  };
}

describe("redactSecretsHook — post_turn finalText scrub", () => {
  it("scrubs an NCE ID in finalText", async () => {
    const payload = makePostTurnPayload("Project NCE-001 is on track.");
    await redactSecretsHook(payload);
    expect(payload.finalText).toContain("[REDACTED]");
    expect(payload.finalText).not.toContain("NCE-001");
  });

  it("scrubs multiple patterns in one pass", async () => {
    const payload = makePostTurnPayload(
      "Email alice@corp.com about NCE-007 and CMP-12345678.",
    );
    await redactSecretsHook(payload);
    expect(payload.finalText).not.toContain("alice@corp.com");
    expect(payload.finalText).not.toContain("NCE-007");
    expect(payload.finalText).not.toContain("CMP-12345678");
  });

  it("is a no-op for benign finalText and does not set redact_log", async () => {
    const payload = makePostTurnPayload("What is the yield for amide coupling?");
    await redactSecretsHook(payload);
    expect(payload.finalText).toBe("What is the yield for amide coupling?");
    expect(payload.ctx.scratchpad.has("redact_log")).toBe(false);
  });

  it("appends to redact_log scratchpad on a hit", async () => {
    const payload = makePostTurnPayload("Project NCE-042 needs follow-up.");
    await redactSecretsHook(payload);
    const log = payload.ctx.scratchpad.get("redact_log") as Array<{
      scope: string;
      replacements: Array<{ pattern: string; original: string }>;
    }>;
    expect(log).toBeDefined();
    expect(log[0]?.scope).toBe("post_turn");
    expect(log[0]?.replacements.some((r) => r.pattern === "NCE")).toBe(true);
  });

  it("handles undefined finalText gracefully", async () => {
    const payload = makePostTurnPayload("");
    payload.finalText = undefined as unknown as string;
    await redactSecretsHook(payload);
    expect(payload.ctx.scratchpad.has("redact_log")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registration — hook lands on post_turn, not pre_tool
// ---------------------------------------------------------------------------

describe("registerRedactSecretsHook", () => {
  it("registers exactly one post_turn hook", () => {
    const lc = new Lifecycle();
    registerRedactSecretsHook(lc);
    expect(lc.count("post_turn")).toBe(1);
    expect(lc.count("pre_tool")).toBe(0);
  });

  it("dispatched post_turn scrubs finalText", async () => {
    const lc = new Lifecycle();
    registerRedactSecretsHook(lc);
    const payload = makePostTurnPayload("NCE-9001 is exciting.");
    await lc.dispatch("post_turn", payload);
    expect(payload.finalText).not.toContain("NCE-9001");
  });
});

// ---------------------------------------------------------------------------
// CPU-DoS regression — audit P1
// ---------------------------------------------------------------------------

describe("redactString — CPU bound", () => {
  it("completes quickly on 200KB arrow-heavy non-SMILES prose", () => {
    // The audit found the RXN_SMILES regex took 3.5s on input of this shape
    // before the >=2 '>' pre-gate. With the gate the regex still runs on a
    // text that happens to contain '>' chars, but the bounded quantifiers
    // keep it well under 1s.
    const block = "> quoted line\n";
    const payload = block.repeat(Math.ceil((200 * 1024) / block.length));
    const replacements: Array<{ pattern: string; original: string }> = [];
    const start = Date.now();
    redactString(payload, replacements);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);
  });

  it("returns input unmodified when over the 5MB cap", () => {
    const huge = "alice@example.com ".repeat(Math.ceil((6 * 1024 * 1024) / 18));
    expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);
    const replacements: Array<{ pattern: string; original: string }> = [];
    const result = redactString(huge, replacements);
    expect(result).toBe(huge);
    expect(replacements).toHaveLength(0);
  });

  it("skips RXN_SMILES regex entirely when the input has fewer than 2 arrows", () => {
    // Sanity: 1MB of arrow-free prose should finish in milliseconds.
    const payload = "ChemClaw is great. ".repeat(Math.ceil((1024 * 1024) / 19));
    const replacements: Array<{ pattern: string; original: string }> = [];
    const start = Date.now();
    redactString(payload, replacements);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(replacements.filter((r) => r.pattern === "RXN_SMILES")).toHaveLength(0);
  });
});
