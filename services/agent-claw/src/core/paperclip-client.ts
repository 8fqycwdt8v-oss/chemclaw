// Paperclip-lite client for the agent-claw harness.
//
// When PAPERCLIP_URL env is set, every turn start calls POST /reserve
// and turn end calls POST /release. When unset, the client is a no-op
// (fallback to local-only budget in core/budget.ts).
//
// Heartbeat: a setInterval fires POST /heartbeat every 30s per active session.
// The interval is cancelled when the session ends.
//
// 429 from /reserve surfaces as a PaperclipBudgetError which the chat route
// converts to a 429 HTTP response.

/** Coarse USD-per-token estimate used when the LLM provider doesn't report
 *  dollar cost back. Single source of truth for both chat.ts (interactive)
 *  and sessions.ts (chained execution) — a previous divergence between
 *  0.000005 and 0.000004 caused chained flows to under-report spend by 20%
 *  and bypass the daily Paperclip cap. Update this in lockstep with
 *  litellm-provider's price table when a real cost passthrough lands. */
export const USD_PER_TOKEN_ESTIMATE = 0.000005;

export class PaperclipBudgetError extends Error {
  readonly retryAfterSeconds: number;
  readonly reason: string;

  constructor(reason: string, retryAfterSeconds: number) {
    super(`Paperclip budget exceeded: ${reason} (retry after ${retryAfterSeconds}s)`);
    this.name = "PaperclipBudgetError";
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface PaperclipClientOptions {
  /** Base URL of the Paperclip-lite sidecar (e.g. http://localhost:3200). */
  paperclipUrl: string | undefined;
  /** Interval in ms between heartbeat POSTs. Default 30s. */
  heartbeatIntervalMs?: number;
  /** fetch implementation — injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface ReservationHandle {
  reservationId: string;
  /** Stop the heartbeat interval and POST /release with actual usage. */
  release(actualTokens: number, actualUsd: number): Promise<void>;
}

const NOOP_HANDLE: ReservationHandle = {
  reservationId: "noop",
  async release() {
    // no-op when Paperclip is disabled
  },
};

export class PaperclipClient {
  private readonly _url: string | undefined;
  private readonly _heartbeatIntervalMs: number;
  private readonly _fetch: typeof fetch;

  constructor(opts: PaperclipClientOptions) {
    this._url = opts.paperclipUrl?.replace(/\/$/, "");
    this._heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this._fetch = opts.fetch ?? globalThis.fetch;
  }

  /** Whether Paperclip is configured (URL is set). */
  get enabled(): boolean {
    return !!this._url;
  }

  /**
   * Reserve budget for a turn.
   *
   * Returns a ReservationHandle whose release() method must be called
   * when the turn ends (success or failure).
   *
   * Throws PaperclipBudgetError on 429.
   * Falls back to a no-op handle if Paperclip is disabled.
   */
  async reserve(opts: {
    userEntraId: string;
    sessionId: string;
    estTokens: number;
    estUsd: number;
  }): Promise<ReservationHandle> {
    if (!this._url) {
      return NOOP_HANDLE;
    }

    const resp = await this._fetch(`${this._url}/reserve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_entra_id: opts.userEntraId,
        session_id: opts.sessionId,
        est_tokens: opts.estTokens,
        est_usd: opts.estUsd,
      }),
    });

    if (resp.status === 429) {
      const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      const reason = (body["reason"] as string) ?? "budget_exceeded";
      const retryAfter = Number(resp.headers.get("Retry-After") ?? 30);
      throw new PaperclipBudgetError(reason, retryAfter);
    }

    if (!resp.ok) {
      throw new Error(`Paperclip /reserve failed: ${resp.status}`);
    }

    const data = (await resp.json()) as { reservation_id: string };
    const { reservation_id: reservationId } = data;
    const url = this._url;
    const fetchFn = this._fetch;
    const sessionId = opts.sessionId;
    const userEntraId = opts.userEntraId;
    const heartbeatIntervalMs = this._heartbeatIntervalMs;

    // Start heartbeat interval.
    let intervalHandle: ReturnType<typeof setInterval> | null = setInterval(() => {
      void fetchFn(`${url}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, user_entra_id: userEntraId }),
      }).catch(() => {
        // Heartbeat failure is non-fatal.
      });
    }, heartbeatIntervalMs);

    const stopHeartbeat = () => {
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    };

    return {
      reservationId,
      async release(actualTokens: number, actualUsd: number): Promise<void> {
        stopHeartbeat();
        await fetchFn(`${url}/release`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reservation_id: reservationId,
            actual_tokens: actualTokens,
            actual_usd: actualUsd,
          }),
        }).catch(() => {
          // Release failure is non-fatal — budget guard may be over-cautious
          // for next turn but won't break anything.
        });
      },
    };
  }
}
