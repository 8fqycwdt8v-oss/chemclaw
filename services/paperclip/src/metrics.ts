// Prometheus text-format metrics for Paperclip-lite.
//
// Tracks: per-user concurrency, total reservations, 429 rate, mean turn duration.
// Exported by GET /metrics.

export interface MetricCounters {
  totalReservations: number;
  totalReleases: number;
  total429s: number;
  totalDurationMs: number; // sum for mean calculation
}

export class MetricsCollector {
  private readonly _counters: MetricCounters = {
    totalReservations: 0,
    totalReleases: 0,
    total429s: 0,
    totalDurationMs: 0,
  };

  recordReservation(): void {
    this._counters.totalReservations++;
  }

  recordRelease(durationMs: number): void {
    this._counters.totalReleases++;
    this._counters.totalDurationMs += durationMs;
  }

  record429(): void {
    this._counters.total429s++;
  }

  /** Render Prometheus text format. */
  render(opts: { activeReservations: number; activeSessions: number }): string {
    const mean =
      this._counters.totalReleases > 0
        ? this._counters.totalDurationMs / this._counters.totalReleases
        : 0;

    const lines: string[] = [
      "# HELP paperclip_reservations_total Total reservation attempts",
      "# TYPE paperclip_reservations_total counter",
      `paperclip_reservations_total ${this._counters.totalReservations}`,
      "",
      "# HELP paperclip_releases_total Total reservation releases",
      "# TYPE paperclip_releases_total counter",
      `paperclip_releases_total ${this._counters.totalReleases}`,
      "",
      "# HELP paperclip_429_total Total 429 budget-exceeded responses",
      "# TYPE paperclip_429_total counter",
      `paperclip_429_total ${this._counters.total429s}`,
      "",
      "# HELP paperclip_mean_turn_duration_ms Mean turn duration across released reservations",
      "# TYPE paperclip_mean_turn_duration_ms gauge",
      `paperclip_mean_turn_duration_ms ${mean.toFixed(2)}`,
      "",
      "# HELP paperclip_active_reservations Current number of active reservations",
      "# TYPE paperclip_active_reservations gauge",
      `paperclip_active_reservations ${opts.activeReservations}`,
      "",
      "# HELP paperclip_active_sessions Current number of active (alive) heartbeat sessions",
      "# TYPE paperclip_active_sessions gauge",
      `paperclip_active_sessions ${opts.activeSessions}`,
    ];

    return lines.join("\n") + "\n";
  }
}
