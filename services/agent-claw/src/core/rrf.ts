// Reciprocal Rank Fusion — Tranche 3 / H1.
//
// Merges multiple ranked lists into a single ranked list using the standard
// RRF formula (Cormack, Clarke & Buettcher 2009):
//
//   score(item) = Σ over lists L of 1 / (k + rank_L(item))
//
// Items absent from a list contribute 0 from that list. The dampener `k`
// (default 60) controls how aggressively top-of-list positions dominate;
// the canonical value is 60 and is what the existing search_knowledge
// implementation uses.
//
// This module exists as a shared utility so the same RRF semantics can be
// reused across the dense+sparse fusion in `search_knowledge` and the
// hybrid KG+vector fusion in `retrieve_related` — and so a single set of
// unit tests pins the math.

/** Default RRF dampener — the value used by both Tranche 1 search_knowledge
 *  and Tranche 3 retrieve_related. */
export const DEFAULT_RRF_K = 60;

export interface RrfMergeOptions<T> {
  /** Function returning the deduplication key for an item. */
  key: (item: T) => string;
  /** Dampener constant. Defaults to {@link DEFAULT_RRF_K}. */
  k?: number;
  /** Maximum number of items to return after fusion. */
  limit?: number;
}

export interface RrfScored<T> {
  item: T;
  /** Aggregate RRF score, rounded to 6 decimal places. */
  score: number;
  /** Per-list 0-based ranks the item appeared in. -1 means "not in this list". */
  ranks: number[];
}

/**
 * Generic Reciprocal Rank Fusion.
 *
 * @param rankings - Array of ranked lists, each ordered best-first.
 * @param opts - Key function (required) plus optional k / limit overrides.
 * @returns A single list sorted by RRF score descending. Each entry carries
 *          the original item, the aggregate score, and per-list ranks (so a
 *          downstream renderer can show "hit on list 0 at rank 2; hit on
 *          list 1 at rank 5").
 *
 * Tie-breaking: when two items have identical RRF scores, the order is
 * deterministic — the item that appeared first in the FIRST input list wins
 * (then second list, etc.). This matches the natural-merge behaviour the
 * existing search_knowledge dense+sparse fusion produces.
 */
export function rrfMerge<T>(
  rankings: T[][],
  opts: RrfMergeOptions<T>,
): RrfScored<T>[] {
  const k = opts.k ?? DEFAULT_RRF_K;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;

  // First-seen order across all lists (used as the tiebreaker when two
  // items end up with identical scores).
  const firstSeen = new Map<string, number>();
  const records = new Map<string, RrfScored<T>>();

  rankings.forEach((ranking, listIdx) => {
    ranking.forEach((item, rankIdx) => {
      const key = opts.key(item);
      const inc = 1 / (k + rankIdx + 1);
      const existing = records.get(key);
      if (existing) {
        existing.score += inc;
        existing.ranks[listIdx] = rankIdx;
      } else {
        const ranks = rankings.map(() => -1);
        ranks[listIdx] = rankIdx;
        records.set(key, { item, score: inc, ranks });
        firstSeen.set(key, firstSeen.size);
      }
    });
  });

  return [...records.entries()]
    .sort(([keyA, a], [keyB, b]) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tiebreak: stable by first-seen order. Map iteration order is
      // insertion order in V8/JS, so this is a defensive backstop.
      return (firstSeen.get(keyA) ?? 0) - (firstSeen.get(keyB) ?? 0);
    })
    .slice(0, limit)
    .map(([, scored]) => ({
      ...scored,
      score: Number(scored.score.toFixed(6)),
    }));
}
