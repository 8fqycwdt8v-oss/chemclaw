// query_chrom_columns — list reversed-phase HPLC columns from the global
// column_inventory catalogue, with their Tanaka 6-axis descriptors and
// operating envelopes.
//
// Used by the agent at round-0 of a chromatography campaign: filter the
// catalogue (chemistry / vendor / MS-compat), forward the resulting
// (id, tanaka) pairs to start_chrom_campaign which encodes them as a
// CategoricalDescriptorInput in the BoFire Domain.
//
// Read-only and project-agnostic — column SKUs are public catalogue data.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";

export const QueryChromColumnsIn = z.object({
  chemistry_filter: z.array(z.string().min(1).max(50)).max(20).optional(),
  vendor_filter: z.array(z.string().min(1).max(50)).max(20).optional(),
  require_ms_compatible: z.boolean().default(false),
  include_inactive: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
});
export type QueryChromColumnsInput = z.infer<typeof QueryChromColumnsIn>;

const ColumnRow = z.object({
  id: z.string().uuid(),
  vendor: z.string(),
  product_line: z.string(),
  chemistry: z.string(),
  particle_size_um: z.number(),
  pore_size_A: z.number(),
  dimensions_mm: z.string(),
  tanaka: z.tuple([
    z.number(), z.number(), z.number(),
    z.number(), z.number(), z.number(),
  ]),
  pH_min: z.number(),
  pH_max: z.number(),
  T_max_C: z.number(),
  flow_max_mLmin: z.number(),
  pressure_max_bar: z.number().int(),
  is_msc: z.boolean(),
  active: z.boolean(),
});

export const QueryChromColumnsOut = z.object({
  columns: z.array(ColumnRow),
  n_total: z.number().int(),
});
export type QueryChromColumnsOutput = z.infer<typeof QueryChromColumnsOut>;

interface DbRow {
  id: string;
  vendor: string;
  product_line: string;
  chemistry: string;
  particle_size_um: string;
  pore_size_A: number;
  dimensions_mm: string;
  tanaka_kPB: string | null;
  tanaka_alphaCH2: string | null;
  tanaka_alphaT_O: string | null;
  tanaka_alphaC_P: string | null;
  tanaka_alphaB_P_pH27: string | null;
  tanaka_alphaB_P_pH76: string | null;
  pH_min: string;
  pH_max: string;
  T_max_C: string;
  flow_max_mLmin: string;
  pressure_max_bar: number;
  is_msc: boolean;
  active: boolean;
}

function n(v: string | null | number): number {
  // Postgres numeric / text columns come back as strings; numeric() and int4
  // coexist so coerce here.
  if (v === null) return Number.NaN;
  return typeof v === "number" ? v : Number(v);
}

export function buildQueryChromColumnsTool(pool: Pool) {
  return defineTool({
    id: "query_chrom_columns",
    description:
      "List reversed-phase HPLC columns from the global column_inventory " +
      "catalogue with their Tanaka 6-axis selectivity descriptors and " +
      "operating envelopes. Filter by chemistry (e.g. C18, Phenyl, F5, T3), " +
      "vendor, MS compatibility. Use the returned (id, tanaka) pairs as " +
      "input to start_chrom_campaign so the BoFire Domain encodes column " +
      "choice as a CategoricalDescriptorInput.",
    inputSchema: QueryChromColumnsIn,
    outputSchema: QueryChromColumnsOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (!input.include_inactive) where.push("active = true");
      if (input.require_ms_compatible) where.push("is_msc = true");
      if (input.chemistry_filter && input.chemistry_filter.length > 0) {
        params.push(input.chemistry_filter);
        where.push(`chemistry = ANY($${params.length}::text[])`);
      }
      if (input.vendor_filter && input.vendor_filter.length > 0) {
        params.push(input.vendor_filter);
        where.push(`vendor = ANY($${params.length}::text[])`);
      }
      const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      params.push(input.limit);

      const client = await pool.connect();
      try {
        const result = await client.query<DbRow>(
          `SELECT id::text,
                  vendor, product_line, chemistry,
                  particle_size_um::text  AS particle_size_um,
                  pore_size_A,
                  dimensions_mm,
                  tanaka_kPB::text          AS "tanaka_kPB",
                  tanaka_alphaCH2::text     AS "tanaka_alphaCH2",
                  tanaka_alphaT_O::text     AS "tanaka_alphaT_O",
                  tanaka_alphaC_P::text     AS "tanaka_alphaC_P",
                  tanaka_alphaB_P_pH27::text AS "tanaka_alphaB_P_pH27",
                  tanaka_alphaB_P_pH76::text AS "tanaka_alphaB_P_pH76",
                  pH_min::text  AS "pH_min",
                  pH_max::text  AS "pH_max",
                  T_max_C::text AS "T_max_C",
                  flow_max_mLmin::text AS "flow_max_mLmin",
                  pressure_max_bar,
                  is_msc, active
             FROM column_inventory
             ${whereClause}
            ORDER BY vendor, product_line, chemistry
            LIMIT $${params.length}`,
          params,
        );
        const columns = result.rows
          .filter((r) =>
            // Drop columns whose Tanaka vector is incomplete — they're not
            // descriptor-encodable in the BoFire CategoricalDescriptorInput.
            r.tanaka_kPB !== null && r.tanaka_alphaCH2 !== null
              && r.tanaka_alphaT_O !== null && r.tanaka_alphaC_P !== null
              && r.tanaka_alphaB_P_pH27 !== null && r.tanaka_alphaB_P_pH76 !== null,
          )
          .map((r) => ({
            id: r.id,
            vendor: r.vendor,
            product_line: r.product_line,
            chemistry: r.chemistry,
            particle_size_um: n(r.particle_size_um),
            pore_size_A: r.pore_size_A,
            dimensions_mm: r.dimensions_mm,
            tanaka: [
              n(r.tanaka_kPB),
              n(r.tanaka_alphaCH2),
              n(r.tanaka_alphaT_O),
              n(r.tanaka_alphaC_P),
              n(r.tanaka_alphaB_P_pH27),
              n(r.tanaka_alphaB_P_pH76),
            ] as [number, number, number, number, number, number],
            pH_min: n(r.pH_min),
            pH_max: n(r.pH_max),
            T_max_C: n(r.T_max_C),
            flow_max_mLmin: n(r.flow_max_mLmin),
            pressure_max_bar: r.pressure_max_bar,
            is_msc: r.is_msc,
            active: r.active,
          }));

        return QueryChromColumnsOut.parse({
          columns,
          n_total: columns.length,
        });
      } finally {
        client.release();
      }
    },
  });
}
