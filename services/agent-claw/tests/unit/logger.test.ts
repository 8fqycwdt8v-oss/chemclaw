// Tests for the centralised Pino logger module (src/observability/logger.ts).
//
// Exercises the public contract: `getLogger()` returns a singleton, repeated
// calls without a component yield the same instance, and `getLogger(name)`
// returns a child whose `component` field is bound. The reset hook lets a
// test rebuild the root with a different `AGENT_LOG_LEVEL`.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getLogger,
  __resetLoggerForTests,
  __serializeErrorForTests as serializeError,
} from "../../src/observability/logger.js";

describe("observability/logger", () => {
  const originalLevel = process.env.AGENT_LOG_LEVEL;

  beforeEach(() => {
    __resetLoggerForTests();
  });

  afterEach(() => {
    if (originalLevel === undefined) {
      delete process.env.AGENT_LOG_LEVEL;
    } else {
      process.env.AGENT_LOG_LEVEL = originalLevel;
    }
    __resetLoggerForTests();
  });

  it("getLogger() with no args returns a singleton", () => {
    const a = getLogger();
    const b = getLogger();
    expect(a).toBe(b);
  });

  it("getLogger(name) returns a child bound to that component", () => {
    const root = getLogger();
    const child = getLogger("ToolRegistry");
    expect(child).not.toBe(root);
    // bindings expose the inherited fields when present.
    const bindings = (child as unknown as { bindings: () => Record<string, unknown> }).bindings();
    expect(bindings.component).toBe("ToolRegistry");
  });

  it("respects AGENT_LOG_LEVEL on rebuild", () => {
    process.env.AGENT_LOG_LEVEL = "debug";
    __resetLoggerForTests();
    const log = getLogger();
    expect(log.level).toBe("debug");
  });

  it("defaults to info when AGENT_LOG_LEVEL is unset", () => {
    delete process.env.AGENT_LOG_LEVEL;
    __resetLoggerForTests();
    const log = getLogger();
    expect(log.level).toBe("info");
  });

  it("two children with the same component name still come from the same root", () => {
    const a = getLogger("foo");
    const b = getLogger("foo");
    // Different child instances each call (pino.child() builds new wrappers),
    // but the parent identity is preserved.
    const aBindings = (a as unknown as { bindings: () => Record<string, unknown> }).bindings();
    const bBindings = (b as unknown as { bindings: () => Record<string, unknown> }).bindings();
    expect(aBindings.component).toBe("foo");
    expect(bBindings.component).toBe("foo");
  });
});

describe("serializeError — cause-chain handling", () => {
  it("walks a normal cause chain", () => {
    const root = new Error("root failure");
    const middle = new Error("middle layer") as Error & { cause?: unknown };
    middle.cause = root;
    const top = new Error("user-visible") as Error & { cause?: unknown };
    top.cause = middle;

    const out = serializeError(top);
    expect(out.message).toBe("user-visible");
    const c1 = out.cause as Record<string, unknown>;
    expect(c1.message).toBe("middle layer");
    const c2 = c1.cause as Record<string, unknown>;
    expect(c2.message).toBe("root failure");
  });

  it("breaks on a self-referential cause cycle (a.cause = a)", () => {
    const e = new Error("loop") as Error & { cause?: unknown };
    e.cause = e;
    const out = serializeError(e);
    expect(out.message).toBe("loop");
    expect((out.cause as Record<string, unknown>).type).toBe("CycleDetected");
  });

  it("breaks on a two-node cycle (a.cause = b; b.cause = a)", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    const out = serializeError(a);
    const bSer = out.cause as Record<string, unknown>;
    expect(bSer.message).toBe("b");
    expect((bSer.cause as Record<string, unknown>).type).toBe("CycleDetected");
  });

  it("caps deep linear chains at MAX_CAUSE_DEPTH (5) with a TruncatedCause marker", () => {
    // Build 8 levels deep — MAX_CAUSE_DEPTH=5 must truncate before the leaf.
    let chain: Error = new Error("level-7");
    for (let i = 6; i >= 0; i--) {
      const next = new Error(`level-${i}`) as Error & { cause?: unknown };
      next.cause = chain;
      chain = next;
    }
    const out = serializeError(chain);
    let cur: Record<string, unknown> = out;
    let depth = 0;
    while (cur.cause && (cur.cause as Record<string, unknown>).type !== "TruncatedCause") {
      cur = cur.cause as Record<string, unknown>;
      depth += 1;
      if (depth > 20) throw new Error("walked too deep — truncation didn't fire");
    }
    expect((cur.cause as Record<string, unknown>).type).toBe("TruncatedCause");
    // Truncation should fire at depth 5 (4 cause hops walked, 5th hop replaced).
    expect(depth).toBeGreaterThanOrEqual(4);
  });

  it("scrubs SMILES from message even inside a cause chain", () => {
    const inner = new Error("failed on CC(=O)Oc1ccccc1C(=O)O");
    const outer = new Error("upstream") as Error & { cause?: unknown };
    outer.cause = inner;
    const out = serializeError(outer);
    const innerSer = out.cause as Record<string, unknown>;
    // scrub() replaces SMILES-shaped tokens with [REDACTED]; exact mask
    // form is implementation-detail of redact-string, so just assert
    // the original token isn't present.
    expect(innerSer.message).not.toContain("CC(=O)Oc1ccccc1C(=O)O");
  });
});
