// Paperclip persistence layer (Phase G — closes deep-review issue #11).
//
// The sidecar's BudgetManager keeps reservation state in-process for fast
// path lookups. This module mirrors writes into Postgres so a restart
// doesn't reset the daily-USD ledger to zero (a 23:59 UTC restart
// otherwise lets a user re-spend their daily cap on the same calendar
// day).
//
// Schema lives in db/init/09_paperclip.sql (paperclip_state) and is
// already shipped — no migration here, just the writer + rehydrator.
//
// Connection role: chemclaw_service (LOGIN BYPASSRLS) so the sidecar can
// insert/update across all users from a single pool. The paperclip_state
// FORCE-RLS policy still enforces user-scoping for any application-level
// reader (e.g. an agent-claw "today's spend" endpoint when one lands).
//
// All methods are best-effort: a Postgres outage logs and continues
// rather than crashing the sidecar — the in-process state is the
// authoritative read-side; persistence is purely for crash-recovery.

import type { Pool } from "pg";

export class PaperclipState {
  constructor(private readonly pool: Pool) {}

  async recordReserved(opts: {
    reservationId: string;
    userEntraId: string;
    sessionId: string;
    estTokens: number;
    estUsd: number;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO paperclip_state
           (reservation_id, user_entra_id, session_id, est_tokens, est_usd, status)
         VALUES ($1, $2, $3, $4, $5, 'reserved')
         ON CONFLICT (reservation_id) DO NOTHING`,
        [opts.reservationId, opts.userEntraId, opts.sessionId, opts.estTokens, opts.estUsd],
      );
    } catch {
      // Best-effort. Sidecar continues without persistence.
    }
  }

  async recordReleased(
    reservationId: string,
    actualTokens: number,
    actualUsd: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE paperclip_state
            SET status = 'released',
                actual_tokens = $1,
                actual_usd = $2,
                released_at = NOW()
          WHERE reservation_id = $3`,
        [actualTokens, actualUsd, reservationId],
      );
    } catch {
      // Best-effort.
    }
  }

  /**
   * Read today's USD totals from paperclip_state grouped by user. Returns a
   * Map keyed by "userEntraId:YYYY-MM-DD" so it can be merged into
   * BudgetManager._dailyUsd directly. Includes both 'reserved' and
   * 'released' rows so a sidecar restart mid-turn doesn't lose the
   * pre-reservation USD until the turn closes.
   */
  async rehydrateDailyUsd(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const today = _utcDateString(new Date());
      const r = await this.pool.query<{ user_entra_id: string; spent: string }>(
        `SELECT user_entra_id,
                SUM(COALESCE(actual_usd, est_usd))::text AS spent
           FROM paperclip_state
          WHERE reserved_at >= $1::date
          GROUP BY user_entra_id`,
        [today],
      );
      for (const row of r.rows) {
        const key = `${row.user_entra_id}:${today}`;
        map.set(key, Number(row.spent));
      }
    } catch {
      // If the rehydrate query fails the sidecar still works — daily
      // ledger just starts at zero (matches pre-persistence behaviour).
    }
    return map;
  }
}

function _utcDateString(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
