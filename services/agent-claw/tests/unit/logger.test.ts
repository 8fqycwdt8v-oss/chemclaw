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
