// Heartbeat tracker for Paperclip-lite.
//
// Sessions POST /heartbeat every 30s. The tracker records last-seen
// per session_id. GET /heartbeat/:session_id returns:
//   200 — session is alive (seen within TTL)
//   410 — session expired or never seen
//
// Special path: GET /heartbeat/health always returns 200 (used as
// compose healthcheck).

const DEFAULT_TTL_MS = 90_000; // 3 × heartbeat interval

export interface HeartbeatEntry {
  sessionId: string;
  userEntraId: string;
  lastSeen: number; // Date.now() ms
}

export class HeartbeatTracker {
  private readonly _sessions = new Map<string, HeartbeatEntry>();
  private readonly _ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this._ttlMs = ttlMs;
  }

  /** Record or refresh a heartbeat for a session. */
  touch(sessionId: string, userEntraId: string): void {
    this._sessions.set(sessionId, {
      sessionId,
      userEntraId,
      lastSeen: Date.now(),
    });
  }

  /** Returns true if the session is alive (seen within TTL). */
  isAlive(sessionId: string): boolean {
    const entry = this._sessions.get(sessionId);
    if (!entry) return false;
    return Date.now() - entry.lastSeen < this._ttlMs;
  }

  /** Returns the entry if alive, undefined otherwise. */
  get(sessionId: string): HeartbeatEntry | undefined {
    return this.isAlive(sessionId) ? this._sessions.get(sessionId) : undefined;
  }

  /** Remove expired sessions. Returns count removed. */
  gc(): number {
    let removed = 0;
    for (const [id, entry] of this._sessions) {
      if (Date.now() - entry.lastSeen >= this._ttlMs) {
        this._sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Total active (alive) sessions. */
  activeCount(): number {
    let count = 0;
    for (const [, entry] of this._sessions) {
      if (Date.now() - entry.lastSeen < this._ttlMs) count++;
    }
    return count;
  }
}
