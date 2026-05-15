// Tests for the redact-tool-output post_tool hook (Tranche 1 / Task G).
//
// The hook walks every tool output and scrubs string leaves through the
// same length-bounded redactor that scrubs outbound assistant text. It is
// pure mutation — no decision contribution to the lifecycle aggregator —
// and is registered LAST in the post_tool phase (order 200) so earlier
// hooks (anti-fabrication, tag-maturity, source-cache,
// detect-mcp-leakage, fact-id-consistency-guard) see the unredacted
// output for fact-ID harvesting / artifact stamping / tripwire detection.

import { describe, it, expect } from "vitest";
import {
  redactToolOutputHook,
  registerRedactToolOutputHook,
} from "../../src/core/hooks/redact-tool-output.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import type { PostToolPayload } from "../../src/core/types.js";
import { makeCtx } from "../helpers/make-ctx.js";

// Default to a source-system tool ID so the existing per-shape / idempotency
// tests below exercise the scrub path. Tests that need to exercise the
// PASS-THROUGH path (e.g. chemistry compute tools) override `toolId`.
function makePayload(
  output: unknown,
  toolId = "query_eln_canonical_reactions",
): PostToolPayload {
  return {
    ctx: makeCtx(),
    toolId,
    input: {},
    output,
  };
}

// ---------------------------------------------------------------------------
// redactToolOutputHook — direct call, structured outputs
// ---------------------------------------------------------------------------

describe("redactToolOutputHook — structured outputs", () => {
  it("redacts an NCE project ID embedded in a string field", async () => {
    const payload = makePayload({
      note: "Project NCE-001 needs follow-up.",
    });
    await redactToolOutputHook(payload);
    const note = (payload.output as { note: string }).note;
    expect(note).not.toContain("NCE-001");
    expect(note).toContain("[REDACTED]");
  });

  it("redacts a CMP compound code embedded in a string field", async () => {
    const payload = makePayload({
      result: "Compound CMP-12345678 was tested at 50C.",
    });
    await redactToolOutputHook(payload);
    const result = (payload.output as { result: string }).result;
    expect(result).not.toContain("CMP-12345678");
    expect(result).toContain("[REDACTED]");
    // Non-sensitive content remains.
    expect(result).toContain("tested at 50C");
  });

  it("redacts an email embedded in a string field", async () => {
    const payload = makePayload({
      contact: "Reach out to alice@corp.com for details.",
    });
    await redactToolOutputHook(payload);
    const contact = (payload.output as { contact: string }).contact;
    expect(contact).not.toContain("alice@corp.com");
    expect(contact).toContain("[REDACTED]");
  });

  it("redacts a reaction SMILES embedded in a string field", async () => {
    const payload = makePayload({
      note: "Reaction CC(=O)Cl.NCCN>>CC(=O)NCCN was suggested.",
    });
    await redactToolOutputHook(payload);
    const note = (payload.output as { note: string }).note;
    expect(note).not.toContain("CC(=O)Cl.NCCN>>CC(=O)NCCN");
    expect(note).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// redactToolOutputHook — nested shapes
// ---------------------------------------------------------------------------

describe("redactToolOutputHook — nested shapes", () => {
  it("recurses into nested arrays of objects", async () => {
    const payload = makePayload({
      steps: [
        { description: "Project NCE-007 is the target." },
        { description: "Compound CMP-99999999 is the lead." },
      ],
    });
    await redactToolOutputHook(payload);
    const steps = (payload.output as {
      steps: { description: string }[];
    }).steps;
    expect(steps[0].description).not.toContain("NCE-007");
    expect(steps[1].description).not.toContain("CMP-99999999");
  });

  it("recurses into deeply nested objects", async () => {
    const payload = makePayload({
      a: { b: { c: { d: { e: { note: "Contact bob@example.com." } } } } },
    });
    await redactToolOutputHook(payload);
    const note = (
      payload.output as {
        a: { b: { c: { d: { e: { note: string } } } } };
      }
    ).a.b.c.d.e.note;
    expect(note).not.toContain("bob@example.com");
    expect(note).toContain("[REDACTED]");
  });

  it("handles arrays of bare strings", async () => {
    const payload = makePayload({
      notes: ["Plain text", "Project NCE-042 is here", "Another plain note"],
    });
    await redactToolOutputHook(payload);
    const notes = (payload.output as { notes: string[] }).notes;
    expect(notes[0]).toBe("Plain text");
    expect(notes[1]).not.toContain("NCE-042");
    expect(notes[2]).toBe("Another plain note");
  });
});

// ---------------------------------------------------------------------------
// redactToolOutputHook — primitive / edge cases
// ---------------------------------------------------------------------------

describe("redactToolOutputHook — primitives and edge cases", () => {
  it("leaves number, boolean, and null fields untouched", async () => {
    const payload = makePayload({
      count: 42,
      name: null,
      ratio: 0.5,
      ok: true,
      notes: "no chemistry here",
    });
    await redactToolOutputHook(payload);
    const out = payload.output as Record<string, unknown>;
    expect(out.count).toBe(42);
    expect(out.name).toBeNull();
    expect(out.ratio).toBe(0.5);
    expect(out.ok).toBe(true);
    expect(out.notes).toBe("no chemistry here");
  });

  it("scrubs a top-level string output", async () => {
    const payload = makePayload(
      "Reach out to operator@example.com about NCE-9001.",
    );
    await redactToolOutputHook(payload);
    expect(payload.output as string).not.toContain("operator@example.com");
    expect(payload.output as string).not.toContain("NCE-9001");
  });

  it("passes through a null output unchanged", async () => {
    const payload = makePayload(null);
    await redactToolOutputHook(payload);
    expect(payload.output).toBeNull();
  });

  it("passes through a numeric output unchanged", async () => {
    const payload = makePayload(42);
    await redactToolOutputHook(payload);
    expect(payload.output).toBe(42);
  });

  it("leaves a benign output unchanged structurally", async () => {
    const before = {
      experiment_id: "abc-123",
      status: "completed",
      yield: 85,
      conditions: "room temp, 18 hours",
    };
    const payload = makePayload({ ...before });
    await redactToolOutputHook(payload);
    expect(payload.output).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — re-running on scrubbed text is a no-op
// ---------------------------------------------------------------------------

describe("redactToolOutputHook — idempotency", () => {
  it("re-running on already-redacted output leaves it unchanged", async () => {
    const payload = makePayload({
      note: "Project [REDACTED] uses [REDACTED] as a reagent.",
    });
    await redactToolOutputHook(payload);
    expect((payload.output as { note: string }).note).toBe(
      "Project [REDACTED] uses [REDACTED] as a reagent.",
    );
  });

  it("converges after one pass — re-running on the redacted output is stable", async () => {
    // The underlying SMILES regex character class includes '.' so a
    // trailing period adjacent to `[REDACTED]` can be absorbed on a
    // second pass; use a shape where the redacted span is surrounded by
    // whitespace so the converged form is provably a fixpoint.
    const payload = makePayload({
      note: "Email alice@corp.com sent before noon",
    });
    await redactToolOutputHook(payload);
    const afterFirst = JSON.parse(JSON.stringify(payload.output)) as unknown;
    await redactToolOutputHook(payload);
    expect(payload.output).toEqual(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// Return shape — no decision contribution
// ---------------------------------------------------------------------------

describe("redactToolOutputHook — return contract", () => {
  it("returns {} (no decision contribution to the lifecycle aggregator)", async () => {
    const payload = makePayload({ note: "NCE-001 something" });
    const result = await redactToolOutputHook(payload);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Registration — wires onto post_tool
// ---------------------------------------------------------------------------

describe("registerRedactToolOutputHook", () => {
  it("registers exactly one post_tool hook", () => {
    const lc = new Lifecycle();
    registerRedactToolOutputHook(lc);
    expect(lc.count("post_tool")).toBe(1);
    expect(lc.count("pre_tool")).toBe(0);
    expect(lc.count("post_turn")).toBe(0);
  });

  it("dispatched post_tool scrubs the output in place (source-system tool)", async () => {
    const lc = new Lifecycle();
    registerRedactToolOutputHook(lc);
    const payload = makePayload({ note: "NCE-9001 is exciting." });
    await lc.dispatch("post_tool", payload);
    expect((payload.output as { note: string }).note).not.toContain("NCE-9001");
  });
});

// ---------------------------------------------------------------------------
// Scope guard — non-source-system tool IDs pass through UNCHANGED
//
// Chemistry compute tools (canonicalize_smiles, find_similar_compounds,
// propose_retrosynthesis, recommend_next_batch, etc.) return SMILES in
// structured fields and the LLM must reason over them to chain calls. A
// blanket scrub would emit `[REDACTED:SMILES]` to the LLM and break the
// agent. Aligns with BACKLOG.md line 208 (scoped scrubbing of
// mcp-eln-local / mcp-logs-sciy payloads only).
// ---------------------------------------------------------------------------

describe("redactToolOutputHook — scope guard", () => {
  function lifecycleWithHook(): Lifecycle {
    const lc = new Lifecycle();
    registerRedactToolOutputHook(lc);
    return lc;
  }

  it("does not redact chemistry tool outputs (e.g. canonicalize_smiles, propose_retrosynthesis)", async () => {
    const lifecycle = lifecycleWithHook();
    const payload: PostToolPayload = {
      toolId: "canonicalize_smiles",
      input: {},
      output: { canonical_smiles: "CCCCCCN(C(=O)CCCCCC)CCCCCC" },
      ctx: makeCtx(),
    };
    await lifecycle.dispatch("post_tool", payload, "tool-use-1");
    expect((payload.output as { canonical_smiles: string }).canonical_smiles).toBe(
      "CCCCCCN(C(=O)CCCCCC)CCCCCC",
    );
  });

  it("does not redact recommend_next_batch / find_similar_compounds outputs", async () => {
    const lifecycle = lifecycleWithHook();
    const payload: PostToolPayload = {
      toolId: "recommend_next_batch",
      input: {},
      output: { proposals: [{ factor_values: { catalyst_smiles: "CCO" } }] },
      ctx: makeCtx(),
    };
    await lifecycle.dispatch("post_tool", payload, "tool-use-1");
    expect(JSON.stringify(payload.output)).toContain("CCO");
  });

  it("does not redact propose_retrosynthesis outputs even when they contain NCE-IDs", async () => {
    // Hypothetical chemistry-tool free-text — STILL must not be scrubbed,
    // because chemistry tools never carry external PII; the gate is per-tool,
    // not per-content.
    const lifecycle = lifecycleWithHook();
    const payload: PostToolPayload = {
      toolId: "propose_retrosynthesis",
      input: {},
      output: { rationale: "Project NCE-001 — synthon disconnection at C-N." },
      ctx: makeCtx(),
    };
    await lifecycle.dispatch("post_tool", payload, "tool-use-1");
    expect((payload.output as { rationale: string }).rationale).toBe(
      "Project NCE-001 — synthon disconnection at C-N.",
    );
  });

  it("redacts source-system tool outputs (fetch_instrument_run)", async () => {
    const lifecycle = lifecycleWithHook();
    const payload: PostToolPayload = {
      toolId: "fetch_instrument_run",
      input: {},
      output: { note: "Operator alice@corp.com — NCE-9001 run" },
      ctx: makeCtx(),
    };
    await lifecycle.dispatch("post_tool", payload, "tool-use-1");
    const note = (payload.output as { note: string }).note;
    expect(note).not.toContain("alice@corp.com");
    expect(note).not.toContain("NCE-9001");
  });

  it("redacts source-system tool outputs (query_lims_*)", async () => {
    const lifecycle = lifecycleWithHook();
    const payload: PostToolPayload = {
      toolId: "query_lims_samples",
      input: {},
      output: { note: "Compound CMP-12345678 routed via LIMS." },
      ctx: makeCtx(),
    };
    await lifecycle.dispatch("post_tool", payload, "tool-use-1");
    expect((payload.output as { note: string }).note).not.toContain(
      "CMP-12345678",
    );
  });
});
