-- Agent autonomy upgrade — persistent session state + todo checklist.
-- See docs/plans/agent-claw-autonomy-upgrade.md for the design.
--
-- Provides the foundation for Claude-Code-like multi-hour work:
--   1. agent_sessions: scratchpad survives across /api/chat POSTs so the
--      agent has continuity. Holds awaiting_question (for clarify-back),
--      last_finish_reason, message_count.
--   2. agent_todos: a checklist the LLM writes via the manage_todos tool
--      and the user watches via the todo_update SSE event.
--
-- RLS: scoped strictly by user_entra_id (FORCE) so a user can only see
-- their own sessions. System workers bypass via chemclaw_service.

BEGIN;

-- --------------------------------------------------------------------
-- agent_sessions
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_entra_id        TEXT NOT NULL,
  -- Free-form per-session state. Hooks and tools read/write keys here.
  -- Today: budget tallies, seenFactIds (as JSON array), redact_log,
  -- session_id (self-reference), and any tool-private scratch keys.
  scratchpad           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Why the last turn ended; client uses this to decide whether to resume.
  -- Values: 'stop' | 'max_steps' | 'budget_exceeded' | 'awaiting_user_input' | 'error'
  last_finish_reason   TEXT,
  -- Set by the ask_user tool; cleared by the next user message.
  awaiting_question    TEXT,
  message_count        INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- TTL — services/optimizer/session_purger evicts rows where expires_at < NOW().
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_updated
  ON agent_sessions (user_entra_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_expires
  ON agent_sessions (expires_at)
  WHERE expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_agent_sessions_updated_at ON agent_sessions;
CREATE TRIGGER trg_agent_sessions_updated_at
  BEFORE UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------
-- agent_todos
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_todos (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  ordering     INT NOT NULL,
  content      TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_todos_session_ordering
  ON agent_todos (session_id, ordering);

DROP TRIGGER IF EXISTS trg_agent_todos_updated_at ON agent_todos;
CREATE TRIGGER trg_agent_todos_updated_at
  BEFORE UPDATE ON agent_todos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------
-- RLS — both tables are owner-scoped via user_entra_id.
-- --------------------------------------------------------------------

ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_sessions_owner_policy ON agent_sessions;
CREATE POLICY agent_sessions_owner_policy ON agent_sessions
  FOR ALL
  USING (user_entra_id = current_setting('app.current_user_entra_id', true))
  WITH CHECK (user_entra_id = current_setting('app.current_user_entra_id', true));

ALTER TABLE agent_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_todos FORCE ROW LEVEL SECURITY;

-- agent_todos is scoped via the parent session row.
DROP POLICY IF EXISTS agent_todos_owner_policy ON agent_todos;
CREATE POLICY agent_todos_owner_policy ON agent_todos
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM agent_sessions s
       WHERE s.id = agent_todos.session_id
         AND s.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM agent_sessions s
       WHERE s.id = agent_todos.session_id
         AND s.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

-- --------------------------------------------------------------------
-- Grants — chemclaw_app gets DML; chemclaw_service bypasses RLS anyway.
-- --------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_sessions TO chemclaw_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_todos    TO chemclaw_app;

COMMIT;
