// Unit tests for the Monty JSON-RPC protocol module.

import { describe, it, expect } from "vitest";
import {
  decodeFrame,
  encodeFrame,
} from "../../../../src/runtime/monty/protocol.js";

describe("encodeFrame", () => {
  it("appends a trailing newline so the child sees a complete line", () => {
    const wire = encodeFrame({ type: "shutdown" });
    expect(wire.endsWith("\n")).toBe(true);
    expect(JSON.parse(wire.trimEnd())).toEqual({ type: "shutdown" });
  });

  it("round-trips a start frame", () => {
    const start = {
      type: "start" as const,
      run_id: "abc",
      script: "x = 1",
      allowed_tools: ["a", "b"],
      inputs: { y: 2 },
      expected_outputs: ["x"],
      wall_time_ms: 5_000,
      max_external_calls: 10,
    };
    const wire = encodeFrame(start);
    expect(JSON.parse(wire.trimEnd())).toEqual(start);
  });
});

describe("decodeFrame", () => {
  it("parses a valid result frame", () => {
    const frame = decodeFrame(
      '{"type":"result","run_id":"r1","outputs":{"x":1}}',
    );
    expect(frame).toEqual({
      type: "result",
      run_id: "r1",
      outputs: { x: 1 },
    });
  });

  it("parses an external_call frame with arbitrary args", () => {
    const frame = decodeFrame(
      '{"type":"external_call","id":3,"name":"canonicalize_smiles","args":{"smiles":"CCO"}}',
    );
    expect(frame).toEqual({
      type: "external_call",
      id: 3,
      name: "canonicalize_smiles",
      args: { smiles: "CCO" },
    });
  });

  it("returns null for empty / whitespace-only lines", () => {
    expect(decodeFrame("")).toBeNull();
    expect(decodeFrame("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(decodeFrame("{not json")).toBeNull();
  });

  it("returns null for unknown frame types", () => {
    expect(decodeFrame('{"type":"bogus","x":1}')).toBeNull();
  });

  it("returns null for missing required fields", () => {
    // ResultFrame requires `outputs` — without it the discriminated union fails.
    expect(decodeFrame('{"type":"result","run_id":"r1"}')).toBeNull();
  });
});
