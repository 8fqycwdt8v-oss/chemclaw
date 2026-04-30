// Shared helpers for the local-mock-ELN builtin tests.
//
// All five builtins are URL-only: they call mcp-eln-local via postJson.
// Tests stub global fetch with a canned response body; helpers below
// keep the test files small and consistent.

import { vi } from "vitest";
import type { ToolContext } from "../../../src/core/types.js";

export const MOCK_ELN_URL = "http://mcp-eln-local:8013";

export function makeCtx(): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

export function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(body),
  });
}

export function mockFetchStatus(status: number, body: string = "") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  });
}

const ENTRY_ID_A = "00000000-0000-0000-0000-000000000a01";
const NOTEBOOK_ID = "00000000-0000-0000-0000-0000000000b1";
const PROJECT_ID = "00000000-0000-0000-0000-0000000000c1";
const REACTION_ID_A = "00000000-0000-0000-0000-0000000000d1";
const SAMPLE_ID_A = "00000000-0000-0000-0000-0000000000e1";

export const SAMPLE_ENTRY = {
  id: ENTRY_ID_A,
  notebook_id: NOTEBOOK_ID,
  project_id: PROJECT_ID,
  project_code: "NCE-1234",
  reaction_id: REACTION_ID_A,
  schema_kind: "ord-v0.3",
  title: "Amide coupling, attempt 1",
  author_email: "alice@example.com",
  signed_by: null,
  status: "in_progress",
  entry_shape: "mixed",
  data_quality_tier: "clean",
  fields_jsonb: { results: { yield_pct: 87.3 } },
  freetext: "ran amide coupling, looks clean",
  freetext_length_chars: 32,
  created_at: "2025-01-15T12:00:00+00:00",
  modified_at: "2025-01-15T12:00:00+00:00",
  signed_at: null,
  citation_uri: `local-mock-eln://eln/entry/${ENTRY_ID_A}`,
  valid_until: "2025-01-22T12:00:00+00:00",
  attachments: [],
  audit_summary: [],
};

export const SAMPLE_REACTION = {
  reaction_id: REACTION_ID_A,
  canonical_smiles_rxn: "CC(=O)O.NC>>CC(=O)NC",
  family: "amide_coupling",
  project_id: PROJECT_ID,
  project_code: "NCE-1234",
  step_number: 1,
  ofat_count: 120,
  mean_yield: 78.4,
  last_activity_at: "2025-02-01T09:00:00+00:00",
  citation_uri: `local-mock-eln://eln/reaction/${REACTION_ID_A}`,
  valid_until: "2025-02-08T09:00:00+00:00",
};

export const SAMPLE_REACTION_DETAIL = {
  ...SAMPLE_REACTION,
  ofat_children: [SAMPLE_ENTRY],
};

export const SAMPLE_SAMPLE = {
  id: SAMPLE_ID_A,
  entry_id: ENTRY_ID_A,
  sample_code: "S-NCE-1234-00001",
  compound_id: null,
  amount_mg: 12.4,
  purity_pct: 98.7,
  notes: null,
  created_at: "2025-01-15T13:00:00+00:00",
  citation_uri: `local-mock-eln://eln/sample/${SAMPLE_ID_A}`,
  valid_until: "2025-01-22T13:00:00+00:00",
  results: [
    {
      id: "00000000-0000-0000-0000-0000000000f1",
      method_id: null,
      metric: "purity_pct",
      value_num: 98.7,
      value_text: null,
      unit: "%",
      measured_at: "2025-01-16T10:00:00+00:00",
      metadata: { instrument: "HPLC-A" },
    },
  ],
};

export const IDS = {
  entryA: ENTRY_ID_A,
  reactionA: REACTION_ID_A,
  sampleA: SAMPLE_ID_A,
  notebook: NOTEBOOK_ID,
  project: PROJECT_ID,
};
