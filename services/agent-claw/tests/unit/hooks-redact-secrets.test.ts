// Tests for the redact-secrets pre_tool hook.

import { describe, it, expect } from "vitest";
import { redactString, redactSecretsHook } from "../../src/core/hooks/redact-secrets.js";
import type { PreToolPayload } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// redactString unit tests
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
// redactSecretsHook integration
// ---------------------------------------------------------------------------

describe("redactSecretsHook — payload mutation", () => {
  function makePayload(input: unknown): PreToolPayload {
    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
    return {
      ctx: {
        userEntraId: "test@example.com",
        scratchpad,
        seenFactIds,
      },
      toolId: "test_tool",
      input,
    };
  }

  it("mutates string input containing NCE ID in-place", async () => {
    const payload = makePayload("Check NCE-001 project status.");
    await redactSecretsHook(payload);
    expect(payload.input as string).toContain("[REDACTED]");
    expect(payload.input as string).not.toContain("NCE-001");
  });

  it("mutates object input containing sensitive fields", async () => {
    const payload = makePayload({ query: "Report for NCE-999999", user: "alice@corp.com" });
    await redactSecretsHook(payload);
    const input = payload.input as Record<string, string>;
    expect(input["query"]).toContain("[REDACTED]");
    expect(input["user"]).toContain("[REDACTED]");
  });

  it("is a no-op for benign input and does not set redact_log", async () => {
    const payload = makePayload({ query: "What is the yield for amide coupling?" });
    await redactSecretsHook(payload);
    const input = payload.input as Record<string, string>;
    expect(input["query"]).toBe("What is the yield for amide coupling?");
    expect(payload.ctx.scratchpad.has("redact_log")).toBe(false);
  });

  it("appends to redact_log scratchpad on a hit", async () => {
    const payload = makePayload("Project NCE-042 needs follow-up.");
    await redactSecretsHook(payload);
    const log = payload.ctx.scratchpad.get("redact_log") as unknown[];
    expect(log).toBeDefined();
    expect(log.length).toBeGreaterThan(0);
  });
});
