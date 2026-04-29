// Phase 11: Mock parity harness — vitest data-driven entrypoint.
//
// Reads every *.json file under tests/parity/scenarios, runs each through
// runScenario(), and asserts the captured trace matches the scenario's
// expected_events list (subsequence match) and expected_finish_reason.
//
// To extend coverage: drop a new JSON file into tests/parity/scenarios.
// No TS code changes required.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, assertEventsMatch } from "./runner.js";
import type { Scenario } from "./scenario.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "scenarios");
const scenarioFiles = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe.each(scenarioFiles)("parity scenario %s", (file) => {
  const scenario = JSON.parse(
    readFileSync(resolve(dir, file), "utf8"),
  ) as Scenario;

  it(`${scenario.name}: trace matches expected events in order`, async () => {
    const { trace, finishReason } = await runScenario(scenario);
    expect(finishReason).toBe(scenario.expected_finish_reason);
    assertEventsMatch(trace, scenario.expected_events);
  });
});
