// Pact / parity test — the TS ERROR_CODES set and the Python ErrorCode
// enum must list the EXACT same strings. A drift bug here means a
// service emits an envelope code that another service can't parse.
//
// Reads the Python file at runtime as plain text, parses out the enum
// member values via String.matchAll, and asserts set equality with the
// TS const.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";

function pythonEnumValues(filePath: string): Set<string> {
  const text = readFileSync(filePath, "utf-8");
  const values = new Set<string>();
  // Match `NAME = "VALUE"` lines inside the ErrorCode class.
  const matches = text.matchAll(
    /^\s+([A-Z_][A-Z_0-9]*)\s*=\s*"([A-Z_][A-Z_0-9]*)"\s*$/gm,
  );
  for (const m of matches) {
    // Both name and value must be the same — the Python enum uses
    // identity strings (NAME = "NAME") so this ensures we don't
    // accidentally pick up an unrelated assignment.
    if (m[1] === m[2]) values.add(m[2]);
  }
  return values;
}

describe("error codes parity (TS ↔ Python)", () => {
  it("the set of error codes matches between codes.ts and error_codes.py", () => {
    const tsValues = new Set(Object.values(ERROR_CODES));
    const pyPath = join(
      process.cwd(),
      "..",
      "mcp_tools",
      "common",
      "error_codes.py",
    );
    const pyValues = pythonEnumValues(pyPath);
    // Both sides must contain exactly the same strings.
    expect([...tsValues].sort()).toEqual([...pyValues].sort());
  });
});
