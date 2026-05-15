// recommend_next_batch — propose the next round of experiments for a campaign.
//
// Reads the campaign's bofire_domain JSON + all measured outcomes from prior
// rounds (RLS-scoped), passes them to mcp_reaction_optimizer /recommend_next,
// inserts a new optimization_rounds row with the proposals, and returns it.
//
// Concurrency: takes a per-campaign advisory lock around the full read /
// fit / insert sequence so two parallel callers don't both burn a GP fit
// only to have one lose the (campaign_id, round_index) UNIQUE race.
//
// Per-round seed is derived from (campaign.seed, round_index) so reruns
// are reproducible but distinct rounds explore different cold-start plates.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import type { ConfigRegistry } from "../../config/registry.js";
import { getLogger } from "../../observability/logger.js";
import { normalizeUrl } from "../../mcp/normalize-url.js";

export const RecommendNextBatchIn = z.object({
  campaign_id: z.string().uuid(),
  n_candidates: z.number().int().min(1).max(200).default(8),
  // Optional override; when omitted the seed is derived deterministically
  // from the campaign's stored seed and the round_index.
  seed: z.number().int().optional(),
});
export type RecommendNextBatchInput = z.infer<typeof RecommendNextBatchIn>;

const Proposal = z.object({
  factor_values: z.record(z.unknown()),
  source: z.string(),
});

export const RecommendNextBatchOut = z.object({
  campaign_id: z.string().uuid(),
  round_id: z.string().uuid(),
  round_index: z.number().int(),
  n_observations: z.number().int(),
  used_bo: z.boolean(),
  fallback_reason: z.string().nullable(),
  strategy: z.string(),
  acquisition: z.string(),
  proposals: z.array(Proposal),
});
export type RecommendNextBatchOutput = z.infer<typeof RecommendNextBatchOut>;

const RecommendNextOut = z.object({
  proposals: z.array(Proposal),
  n_observations: z.number().int(),
  used_bo: z.boolean(),
  fallback_reason: z.string().nullable().optional(),
  strategy: z.string(),
  acquisition: z.string(),
});

// Shape sanity for bofire_domain read from optimization_campaigns.bofire_domain.
// Stored as JSONB; we don't validate against the BoFire Domain ABI (Python-side),
// but rejecting non-objects (string/number/null/array) catches corrupt rows
// before they surface as an opaque MCP 422.
const BofireDomainShape = z.record(z.unknown());

const TIMEOUT_MS = 120_000;
const log = getLogger("recommend_next_batch");

interface CampaignRow {
  bofire_domain: unknown;
  status: string;
  strategy: string;
  acquisition: string;
  seed: number | null;
  nce_project_id: string;
}

interface RoundRow {
  measured_outcomes: unknown;
  round_index: number;
}

// Derive a per-round seed from the campaign seed and round_index. SHA-256
// gives uniform mixing; we take 31 bits (positive int32) to stay within
// numpy/torch seed bounds without sign tricks.
function deriveRoundSeed(campaignSeed: number, roundIndex: number): number {
  const h = createHash("sha256");
  h.update(String(campaignSeed));
  h.update(":");
  h.update(String(roundIndex));
  const digest = h.digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

// Stable 32-bit hash of the campaign UUID for the advisory-lock key. Postgres
// pg_advisory_xact_lock(bigint) takes one signed 64-bit; we pack tag+hash so
// the lock space doesn't collide with workflow_engine / other consumers.
const ADVISORY_LOCK_NAMESPACE = 0x0BC07A11n; // "BO TAIL"
function advisoryLockKey(campaignId: string): bigint {
  const h = createHash("sha256").update(campaignId).digest();
  // Lower 32 bits of digest, upper 32 bits = namespace tag.
  const lo = BigInt(h.readUInt32BE(0));
  return (ADVISORY_LOCK_NAMESPACE << 32n) | lo;
}

export function buildRecommendNextBatchTool(
  pool: Pool,
  optimizerUrl: string,
  configRegistry: ConfigRegistry,
) {
  const base = normalizeUrl(optimizerUrl);
  return defineTool({
    id: "recommend_next_batch",
    description:
      "Propose the next batch of experiments for a closed-loop optimization " +
      "campaign. Pulls measured outcomes from prior rounds (RLS-scoped), fits " +
      "a BoFire Strategy honoring the campaign's strategy + acquisition + " +
      "constraints, returns n_candidates next conditions. Cold-start " +
      "(< bo.min_observations_for_bo) returns space-filling random samples; " +
      "the response carries `fallback_reason` whenever the BO path was bypassed.",
    inputSchema: RecommendNextBatchIn,
    outputSchema: RecommendNextBatchOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("recommend_next_batch requires userEntraId in context");
      }

      const lockKey = advisoryLockKey(input.campaign_id);

      // Resolve the cold-start threshold for the user's scope. Falls back
      // silently to MIN_OBSERVATIONS_FOR_BO=3 when the table is empty.
      const minObs = await configRegistry.getNumber(
        "bo.min_observations_for_bo",
        { user: userEntraId },
        3,
      );

      // Single transaction holds the advisory lock from read through INSERT.
      const result = await withUserContext(pool, userEntraId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey.toString()]);

        const camp = await client.query<CampaignRow>(
          `SELECT bofire_domain, status, strategy, acquisition,
                  seed, nce_project_id::text
             FROM optimization_campaigns WHERE id = $1`,
          [input.campaign_id],
        );
        const c = camp.rows[0];
        if (c === undefined) {
          throw new Error("campaign_not_found");
        }
        if (c.status !== "active") {
          throw new Error(`campaign_not_active:${c.status}`);
        }
        const rounds = await client.query<RoundRow>(
          `SELECT measured_outcomes, round_index
             FROM optimization_rounds
            WHERE campaign_id = $1
            ORDER BY round_index ASC`,
          [input.campaign_id],
        );
        const allMeasured: unknown[] = [];
        for (const row of rounds.rows) {
          if (row.measured_outcomes !== null && Array.isArray(row.measured_outcomes)) {
            for (const item of row.measured_outcomes) {
              allMeasured.push(item);
            }
          }
        }
        const maxIdx = rounds.rows.reduce(
          (acc, r) => Math.max(acc, r.round_index),
          -1,
        );
        const nextIndex = maxIdx + 1;
        const domainParsed = BofireDomainShape.safeParse(c.bofire_domain);
        if (!domainParsed.success) {
          throw new Error("bofire_domain_corrupt");
        }

        const seed =
          input.seed ??
          deriveRoundSeed(c.seed ?? 42, nextIndex);

        const reco = await postJson(
          `${base}/recommend_next`,
          {
            bofire_domain: domainParsed.data,
            measured_outcomes: allMeasured,
            n_candidates: input.n_candidates,
            seed,
            strategy: c.strategy,
            acquisition: c.acquisition,
            min_observations_for_bo: minObs,
          },
          RecommendNextOut,
          TIMEOUT_MS,
          "mcp-reaction-optimizer",
        );

        const insertRes = await client.query<{ id: string }>(
          `INSERT INTO optimization_rounds
             (campaign_id, round_index, proposals)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (campaign_id, round_index) DO NOTHING
           RETURNING id::text`,
          [input.campaign_id, nextIndex, JSON.stringify(reco.proposals)],
        );
        const roundRow = insertRes.rows[0];
        if (!roundRow) {
          // Advisory lock should make this unreachable, but the (campaign_id,
          // round_index) UNIQUE keeps it as a typed signal rather than a
          // raw 23505 if it ever happens.
          throw new Error("round_index_conflict");
        }

        // Bump the parent campaign's etag inside the same advisory-lock'd txn
        // so an external consumer holding a snapshot can detect that a new
        // round landed. Placed AFTER the round INSERT so a rollback before
        // INSERT leaves etag unchanged. The advisory lock already serialises
        // concurrent writers, so this is single-writer by construction.
        await client.query(
          `UPDATE optimization_campaigns
              SET etag = etag + 1,
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [input.campaign_id],
        );

        // Surface BoFire failures durably so a campaign that has degraded to
        // random isn't invisible. Cold-start is benign (the loop is
        // designed for it); only `random_*_failed` paths are recorded.
        //
        // Wrapped in a SAVEPOINT so an audit-write failure (e.g. partially-
        // migrated dev DB missing record_error_event) doesn't roll back the
        // optimization_rounds INSERT this transaction just made — losing the
        // round is much worse than losing the audit row.
        const failureSource = reco.proposals.find(
          (p) => p.source.startsWith("random_") && p.source.endsWith("_failed"),
        );
        if (failureSource) {
          log.warn(
            {
              campaign_id: input.campaign_id,
              round_id: roundRow.id,
              fallback_reason: reco.fallback_reason,
              source: failureSource.source,
            },
            "BO fell back to random",
          );
          await client.query("SAVEPOINT bo_audit");
          try {
            await client.query(
              `SELECT record_error_event($1, $2, $3, $4::jsonb)`,
              [
                "mcp-reaction-optimizer",
                "BO_FALLBACK_TO_RANDOM",
                `recommend_next_batch fell back to random: source=${failureSource.source}`,
                JSON.stringify({
                  campaign_id: input.campaign_id,
                  round_id: roundRow.id,
                  round_index: nextIndex,
                  fallback_reason: reco.fallback_reason ?? null,
                  strategy: reco.strategy,
                  acquisition: reco.acquisition,
                }),
              ],
            );
            await client.query("RELEASE SAVEPOINT bo_audit");
          } catch (auditErr) {
            await client.query("ROLLBACK TO SAVEPOINT bo_audit");
            log.warn(
              {
                campaign_id: input.campaign_id,
                round_id: roundRow.id,
                err: auditErr instanceof Error ? auditErr.message : String(auditErr),
              },
              "record_error_event failed; BO round retained, audit row dropped",
            );
          }
        }

        return { roundRow, reco, nextIndex };
      });

      return RecommendNextBatchOut.parse({
        campaign_id: input.campaign_id,
        round_id: result.roundRow.id,
        round_index: result.nextIndex,
        n_observations: result.reco.n_observations,
        used_bo: result.reco.used_bo,
        fallback_reason: result.reco.fallback_reason ?? null,
        strategy: result.reco.strategy,
        acquisition: result.reco.acquisition,
        proposals: result.reco.proposals,
      });
    },
  });
}
