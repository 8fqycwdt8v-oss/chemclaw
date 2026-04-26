// forge_tool -- 4-stage Forjador meta-tool (Phase D.1).
//
// Inspired by El Agente Forjador (Aspuru-Guzik et al., arXiv 2604.14609).
// The agent calls this tool to synthesize reusable Python tools on demand.
//
// 4 stages:
//   1. Analyze   -- validate schemas + test cases; reject name conflicts.
//   2. Generate  -- ask LiteLLM to author Python implementing the spec.
//   3. Execute   -- run each test case via E2B sandbox (run_program semantics).
//   4. Evaluate  -- compare actual vs expected; persist on all-pass.
//
// Persistence (all-pass only):
//   - skill_library row: kind='forged_tool', active=false, shadow_until=NOW()+14 days.
//   - tools table row:   source='forged', enabled=true.
//   - Python code on disk: FORGED_TOOLS_DIR/<uuid>.py
//
// On any-fail: return failure list; do NOT persist. Agent may retry.
//
// Loop guard: forge_tool and run_program cannot themselves be forged.

import { z } from "zod";
import type { Pool } from "pg";
import { promises as fsp } from "fs";
import { join } from "path";
import { randomUUID, createHash } from "crypto";
import { defineTool } from "../tool.js";
import type { LlmProvider, ModelRole } from "../../llm/provider.js";
import type { SandboxClient } from "../../core/sandbox.js";
import { wrapCode, parseOutputs } from "./run_program.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TestCaseSchema = z.object({
  input: z.record(z.unknown()),
  expected_output: z.record(z.unknown()),
  tolerance: z.number().min(0).max(1).optional(),
});

export const ForgeToolIn = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "name must be a lowercase slug (letters, digits, underscores)"),
  description: z.string().min(1).max(2000),
  input_schema_json: z.record(z.unknown()),
  output_schema_json: z.record(z.unknown()),
  test_cases: z
    .array(TestCaseSchema)
    .min(2, "at least 2 test cases required")
    .max(10, "at most 10 test cases allowed"),
  implementation_hint: z.string().max(2000).optional(),
  /** Phase D.5: fork from an existing forged tool. */
  parent_tool_id: z.string().uuid().optional(),
});
export type ForgeToolInput = z.infer<typeof ForgeToolIn>;

const TestFailureSchema = z.object({
  test_index: z.number().int(),
  error: z.string(),
  observed_output: z.record(z.unknown()),
});

export const ForgeToolOut = z.object({
  tool_id: z.string().uuid(),
  validation: z.object({
    passed: z.number().int(),
    failed: z.number().int(),
    failures: z.array(TestFailureSchema),
  }),
  persisted: z.boolean(),
  skill_library_row_id: z.string().uuid().optional(),
  /** Version of the newly created tool (1 for new tools, parent.version+1 for forks). */
  version: z.number().int().optional(),
});
export type ForgeToolOutput = z.infer<typeof ForgeToolOut>;

// ---------------------------------------------------------------------------
// Loop guard -- these tools cannot be the implementation of a forged tool.
// ---------------------------------------------------------------------------

export const PROTECTED_TOOL_NAMES = new Set(["forge_tool", "run_program"]);

// ---------------------------------------------------------------------------
// Zod-schema validation helper (re-validate as JSON schema).
// ---------------------------------------------------------------------------

export function validateJsonSchema(schema: Record<string, unknown>): void {
  if (!schema || typeof schema !== "object") {
    throw new Error("schema must be a non-null object");
  }
  if (schema["type"] !== "object") {
    throw new Error("top-level schema type must be 'object'");
  }
  if (schema["properties"] !== undefined && typeof schema["properties"] !== "object") {
    throw new Error("schema.properties must be an object if present");
  }
}

// ---------------------------------------------------------------------------
// Tolerance-aware equality comparison.
// ---------------------------------------------------------------------------

export function valuesMatch(
  expected: unknown,
  actual: unknown,
  tolerance?: number,
): boolean {
  if (expected === actual) return true;
  if (expected === null || actual === null) return false;

  if (typeof expected === "number" && typeof actual === "number" && tolerance !== undefined) {
    return Math.abs(expected - actual) <= tolerance;
  }

  if (typeof expected === "object" && typeof actual === "object") {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const keys = Object.keys(e);
    for (const k of keys) {
      if (!valuesMatch(e[k], a[k], tolerance)) return false;
    }
    return true;
  }

  return JSON.stringify(expected) === JSON.stringify(actual);
}

// ---------------------------------------------------------------------------
// LLM code generation prompt.
// ---------------------------------------------------------------------------

export function buildGenerationPrompt(
  input: ForgeToolInput,
  availableHelpers: string[],
  parentCode?: string,
): { system: string; user: string } {
  const system = `You are an expert Python programmer generating a reusable tool for the ChemClaw chemistry intelligence platform.
You will be given a tool specification and must produce valid Python code that implements it.
The code runs inside an isolated E2B sandbox and may optionally use the chemclaw stub library.
Available chemclaw helpers (import as: import chemclaw): ${availableHelpers.join(", ")}.
Return a JSON object with exactly two keys:
  "python_code": string -- complete Python implementation. Assign results to output variable names.
  "explanation": string -- brief rationale (1-2 sentences).
The code must NOT import external packages beyond the Python standard library and the chemclaw stub.
Do NOT use any shell-execution functions.`;

  const parentSection = parentCode
    ? `\nParent tool code (use as starting point; modify where needed):\n\`\`\`python\n${parentCode}\n\`\`\`\n`
    : "";

  const user = `Tool name: ${input.name}
Description: ${input.description}

Input schema (JSON Schema):
${JSON.stringify(input.input_schema_json, null, 2)}

Output schema (JSON Schema):
${JSON.stringify(input.output_schema_json, null, 2)}

Test cases (${input.test_cases.length}):
${input.test_cases.map((tc, i) => `  [${i}] input=${JSON.stringify(tc.input)} expected_output=${JSON.stringify(tc.expected_output)}`).join("\n")}
${parentSection}
${input.implementation_hint ? `Implementation hint: ${input.implementation_hint}` : ""}

Write the Python implementation. The output variables must match the keys in the output schema.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// DB helpers.
// ---------------------------------------------------------------------------

async function toolNameExists(pool: Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM tools WHERE name = $1) AS exists`,
    [name],
  );
  return rows[0]?.exists ?? false;
}

async function skillLibraryNameExists(pool: Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM skill_library WHERE name = $1) AS exists`,
    [name],
  );
  return rows[0]?.exists ?? false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildForgeToolTool(
  pool: Pool,
  sandboxClient: SandboxClient,
  llm: LlmProvider,
  forgedToolsDir: string,
  userEntraId: string,
  /** Which model role forged the tool (Phase D.5: weak-from-strong). */
  forgedByModel?: string,
  forgedByRole?: ModelRole,
) {
  return defineTool({
    id: "forge_tool",
    description:
      "Forge a new reusable Python tool using the 4-stage Forjador algorithm " +
      "(analyze -> generate -> execute -> evaluate). " +
      "Provide a name (slug), description, JSON Schema for inputs and outputs, " +
      "at least 2 test cases, and an optional implementation hint. " +
      "On all-pass the tool is persisted in the skill_library (shadow period: 14 days). " +
      "On any-fail the failures are returned for re-iteration. " +
      "Do NOT use this tool to forge forge_tool or run_program themselves.",
    inputSchema: ForgeToolIn,
    outputSchema: ForgeToolOut,

    execute: async (_ctx, input) => {
      const toolId = randomUUID();

      // ---- Stage 1: Analyze ------------------------------------------------

      // Loop guard.
      if (PROTECTED_TOOL_NAMES.has(input.name)) {
        throw new Error(
          `forge_tool: cannot forge '${input.name}' -- it is a protected tool that guards the forging loop.`,
        );
      }

      // Validate schemas.
      try {
        validateJsonSchema(input.input_schema_json as Record<string, unknown>);
        validateJsonSchema(input.output_schema_json as Record<string, unknown>);
      } catch (err) {
        throw new Error(`forge_tool: schema validation failed: ${(err as Error).message}`);
      }

      // Phase D.5: resolve parent tool if forking.
      let parentVersion = 0;
      let parentCode: string | null = null;

      if (input.parent_tool_id) {
        const { rows: parentRows } = await pool.query<{
          id: string;
          version: number;
          scripts_path: string | null;
        }>(
          `SELECT id::text, version, scripts_path
             FROM skill_library
            WHERE id = $1::uuid AND kind = 'forged_tool'`,
          [input.parent_tool_id],
        );
        const parent = parentRows[0];
        if (!parent) {
          throw new Error(
            `forge_tool: parent_tool_id '${input.parent_tool_id}' not found in skill_library.`,
          );
        }
        parentVersion = parent.version;
        if (parent.scripts_path) {
          try {
            parentCode = await fsp.readFile(parent.scripts_path, "utf-8");
          } catch {
            // Non-fatal: parent code not readable — proceed without it.
            parentCode = null;
          }
        }
      }

      // Check name conflict only for NEW tools (forks share the same name + bump version).
      if (!input.parent_tool_id) {
        const [toolConflict, skillConflict] = await Promise.all([
          toolNameExists(pool, input.name),
          skillLibraryNameExists(pool, input.name),
        ]);
        if (toolConflict || skillConflict) {
          throw new Error(
            `forge_tool: tool name '${input.name}' already exists in the registry. ` +
              `Choose a different name or delete the existing tool first.`,
          );
        }
      }

      // ---- Stage 2: Generate -----------------------------------------------

      const { system, user } = buildGenerationPrompt(
        input,
        [
          "fetch_document",
          "query_kg",
          "find_similar_reactions",
          "canonicalize_smiles",
          "embed_text",
          "compute_drfp",
        ],
        parentCode ?? undefined,
      );

      const raw = await llm.completeJson({ system, user, role: forgedByRole });
      const rawObj = raw as Record<string, unknown>;

      let pythonCode: string;

      if (
        !rawObj ||
        typeof rawObj["python_code"] !== "string" ||
        !rawObj["python_code"].trim()
      ) {
        throw new Error(
          "forge_tool: LLM did not return a valid python_code field in stage 2 (generate).",
        );
      }
      pythonCode = rawObj["python_code"] as string;

      // ---- Stage 3: Execute + Stage 4: Evaluate ----------------------------

      let passed = 0;
      let failed = 0;
      const failures: Array<{
        test_index: number;
        error: string;
        observed_output: Record<string, unknown>;
      }> = [];

      for (let i = 0; i < input.test_cases.length; i++) {
        const tc = input.test_cases[i]!;
        const expectedOutputKeys = Object.keys(tc.expected_output);

        const handle = await sandboxClient.createSandbox();
        let observedOutput: Record<string, unknown> = {};
        let testError: string | null = null;

        try {
          const wrappedCode = wrapCode(pythonCode, tc.input, expectedOutputKeys);
          const result = await sandboxClient.executePython(handle, wrappedCode, {}, undefined, 20_000);

          if (result.exit_code !== 0) {
            testError = `exit_code=${result.exit_code}: ${result.stderr.slice(0, 500)}`;
          } else {
            observedOutput = parseOutputs(result.stdout) ?? {};
            // Evaluate each expected output key.
            for (const [k, expectedVal] of Object.entries(tc.expected_output)) {
              if (!valuesMatch(expectedVal, observedOutput[k], tc.tolerance)) {
                testError =
                  `output mismatch for key '${k}': ` +
                  `expected ${JSON.stringify(expectedVal)}, ` +
                  `got ${JSON.stringify(observedOutput[k])}`;
                break;
              }
            }
          }
        } catch (err) {
          testError = (err as Error).message;
        } finally {
          await sandboxClient.closeSandbox(handle);
        }

        if (testError) {
          failed++;
          failures.push({
            test_index: i,
            error: testError,
            observed_output: observedOutput,
          });
        } else {
          passed++;
        }
      }

      // ---- Persistence (all-pass only) -------------------------------------

      let persisted = false;
      let skillLibraryRowId: string | undefined;
      const newVersion = parentVersion + 1;

      if (failed === 0) {
        // Ensure directory exists.
        await fsp.mkdir(forgedToolsDir, { recursive: true });

        const scriptsPath = join(forgedToolsDir, `${toolId}.py`);
        await fsp.writeFile(scriptsPath, pythonCode, "utf-8");

        // SHA-256 of the file we just wrote — verified at every call by the
        // tool registry. Hash the in-memory string (matches what the registry
        // re-reads from disk via readFileSync(..., "utf-8")).
        const codeSha256 = createHash("sha256")
          .update(pythonCode, "utf-8")
          .digest("hex");

        const promptMd =
          `## ${input.name}\n\n${input.description}\n\n` +
          `**Input schema:**\n\`\`\`json\n${JSON.stringify(input.input_schema_json, null, 2)}\n\`\`\`\n\n` +
          `**Output schema:**\n\`\`\`json\n${JSON.stringify(input.output_schema_json, null, 2)}\n\`\`\``;

        const schemaJson = {
          type: "object",
          description: input.description,
          properties: (input.input_schema_json as Record<string, unknown>)["properties"] ?? {},
          required: (input.input_schema_json as Record<string, unknown>)["required"] ?? [],
        };

        // Insert skill_library row (Phase D.5: includes scope, forged_by_model/role, parent_tool_id, version).
        // code_sha256 is verified at every call by the tool registry.
        const skillResult = await pool.query<{ id: string }>(
          `INSERT INTO skill_library
             (name, prompt_md, scripts_path, kind, active, shadow_until,
              proposed_by_user_entra_id, scope, forged_by_model, forged_by_role,
              parent_tool_id, version, code_sha256)
           VALUES ($1, $2, $3, 'forged_tool', false, NOW() + INTERVAL '14 days', $4,
                   'private', $5, $6, $7, $8, $9)
           RETURNING id::text AS id`,
          [
            input.name,
            promptMd,
            scriptsPath,
            userEntraId,
            forgedByModel ?? null,
            forgedByRole ?? null,
            input.parent_tool_id ?? null,
            newVersion,
            codeSha256,
          ],
        );
        skillLibraryRowId = skillResult.rows[0]?.id;

        // Insert tools table row (source='forged').
        await pool.query(
          `INSERT INTO tools (id, name, source, schema_json, description, enabled)
           VALUES ($1::uuid, $2, 'forged', $3, $4, true)
           ON CONFLICT (name) DO NOTHING`,
          [toolId, input.name, JSON.stringify(schemaJson), input.description],
        );

        // Phase D.5: persist supplied test cases in forged_tool_tests.
        if (skillLibraryRowId) {
          for (const tc of input.test_cases) {
            await pool.query(
              `INSERT INTO forged_tool_tests
                 (forged_tool_id, input_json, expected_output_json, tolerance_json, kind)
               VALUES ($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb, 'functional')`,
              [
                skillLibraryRowId,
                JSON.stringify(tc.input),
                JSON.stringify(tc.expected_output),
                tc.tolerance !== undefined ? JSON.stringify({ _global: tc.tolerance }) : null,
              ],
            );
          }
        }

        persisted = true;
      }

      return {
        tool_id: toolId,
        validation: { passed, failed, failures },
        persisted,
        skill_library_row_id: skillLibraryRowId,
        version: newVersion,
      };
    },
  });
}
