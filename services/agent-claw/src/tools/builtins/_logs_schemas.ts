// Shared Zod schemas for the three mcp-logs-sciy builtins
// (query_instrument_runs / fetch_instrument_run / query_instrument_datasets).
// Mirrors services/mcp_tools/mcp_logs_sciy/main.py.

import { z } from "zod";

const InstrumentKind = z.enum([
  "HPLC",
  "NMR",
  "MS",
  "GC-MS",
  "LC-MS",
  "IR",
]);

export const Track = z.object({
  track_index: z.number().int().nonnegative(),
  detector: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  peaks: z.array(z.record(z.unknown())).default([]),
});

export const LogsDataset = z.object({
  backend: z.enum(["fake-postgres", "real"]),
  uid: z.string(),
  name: z.string(),
  instrument_kind: InstrumentKind,
  instrument_serial: z.string().nullable().optional(),
  method_name: z.string().nullable().optional(),
  sample_id: z.string().nullable().optional(),
  sample_name: z.string().nullable().optional(),
  operator: z.string().nullable().optional(),
  measured_at: z.string(),
  parameters: z.record(z.unknown()).default({}),
  tracks: z.array(Track).default([]),
  project_code: z.string().nullable().optional(),
  citation_uri: z.string(),
});

export const InstrumentKindEnum = InstrumentKind;
