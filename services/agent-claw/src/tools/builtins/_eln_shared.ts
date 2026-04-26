// Shared Zod schemas + types for the local-mock-ELN builtins.
//
// These mirror the response shapes of the mcp-eln-local FastAPI app
// (services/mcp_tools/mcp_eln_local/main.py). Kept in one place so the
// five builtins below stay in lockstep with the wire format.

import { z } from "zod";

export const AuditEntrySchema = z.object({
  actor_email: z.string().nullable().optional(),
  action: z.string(),
  field_path: z.string().nullable().optional(),
  occurred_at: z.string(),
  reason: z.string().nullable().optional(),
});

export const AttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mime_type: z.string().nullable().optional(),
  size_bytes: z.number().int().nullable().optional(),
  description: z.string().nullable().optional(),
  uri: z.string().nullable().optional(),
  created_at: z.string(),
});

export const ElnEntrySchema = z.object({
  id: z.string(),
  notebook_id: z.string(),
  project_id: z.string(),
  project_code: z.string().nullable().optional(),
  reaction_id: z.string().nullable().optional(),
  schema_kind: z.string(),
  title: z.string(),
  author_email: z.string().nullable().optional(),
  signed_by: z.string().nullable().optional(),
  status: z.string(),
  entry_shape: z.string(),
  data_quality_tier: z.string(),
  fields_jsonb: z.record(z.unknown()),
  freetext: z.string().nullable().optional(),
  freetext_length_chars: z.number().int(),
  created_at: z.string(),
  modified_at: z.string(),
  signed_at: z.string().nullable().optional(),
  citation_uri: z.string(),
  valid_until: z.string(),
  attachments: z.array(AttachmentSchema).default([]),
  audit_summary: z.array(AuditEntrySchema).default([]),
});

export type ElnEntry = z.infer<typeof ElnEntrySchema>;

export const CanonicalReactionSchema = z.object({
  reaction_id: z.string(),
  canonical_smiles_rxn: z.string(),
  family: z.string(),
  project_id: z.string(),
  project_code: z.string().nullable().optional(),
  step_number: z.number().int().nullable().optional(),
  ofat_count: z.number().int(),
  mean_yield: z.number().nullable().optional(),
  last_activity_at: z.string().nullable().optional(),
  citation_uri: z.string(),
  valid_until: z.string(),
});
export type CanonicalReaction = z.infer<typeof CanonicalReactionSchema>;

export const CanonicalReactionDetailSchema = CanonicalReactionSchema.extend({
  ofat_children: z.array(ElnEntrySchema).default([]),
});
export type CanonicalReactionDetail = z.infer<typeof CanonicalReactionDetailSchema>;

export const ResultSchema = z.object({
  id: z.string(),
  method_id: z.string().nullable().optional(),
  metric: z.string(),
  value_num: z.number().nullable().optional(),
  value_text: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  measured_at: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const SampleSchema = z.object({
  id: z.string(),
  entry_id: z.string(),
  sample_code: z.string(),
  compound_id: z.string().nullable().optional(),
  amount_mg: z.number().nullable().optional(),
  purity_pct: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
  citation_uri: z.string(),
  valid_until: z.string(),
  results: z.array(ResultSchema).default([]),
});
export type Sample = z.infer<typeof SampleSchema>;
