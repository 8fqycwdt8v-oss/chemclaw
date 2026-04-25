-- Paperclip-lite persistence schema.
-- Stores reservation history for crash recovery and per-day USD accounting.
-- The hot reservation state lives in the sidecar's in-process Map;
-- Postgres is the persistence layer for crash recovery only.

CREATE TABLE IF NOT EXISTS paperclip_state (
  reservation_id   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_entra_id    TEXT        NOT NULL,
  session_id       TEXT        NOT NULL,
  est_tokens       INT         NOT NULL,
  est_usd          NUMERIC(10,6) NOT NULL,
  actual_tokens    INT,
  actual_usd       NUMERIC(10,6),
  status           TEXT        NOT NULL
                     CHECK (status IN ('reserved', 'released', 'expired'))
                     DEFAULT 'reserved',
  reserved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_paperclip_user_day
  ON paperclip_state (user_entra_id, reserved_at DESC);

CREATE INDEX IF NOT EXISTS idx_paperclip_status
  ON paperclip_state (status, reserved_at DESC);

-- RLS: users see only their own reservations (system context bypasses).
ALTER TABLE paperclip_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY paperclip_own_policy ON paperclip_state
  USING (
    current_setting('app.current_user_entra_id', true) = ''
    OR user_entra_id = current_setting('app.current_user_entra_id', true)
  );
