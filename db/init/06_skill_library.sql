-- Phase C.3: procedural memory — skill_library table.
-- Stores agent-induced skills (prompted from successful turns via /learn).
-- Re-applicable: IF NOT EXISTS everywhere.

BEGIN;

CREATE TABLE IF NOT EXISTS skill_library (
  id                     uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                   text        NOT NULL,
  prompt_md              text        NOT NULL,
  scripts_path           text,                         -- nullable; future: forged-tool code path (Phase D)
  source_trace_id        text,                         -- the chat trace this was induced from
  success_count          int         NOT NULL DEFAULT 0,
  total_runs             int         NOT NULL DEFAULT 0,
  active                 boolean     NOT NULL DEFAULT false,
  version                int         NOT NULL DEFAULT 1,
  kind                   text        NOT NULL DEFAULT 'prompt'
                                     CHECK (kind IN ('prompt','forged_tool')),
  proposed_by_user_entra_id text     NOT NULL,
  shadow_until           timestamptz,                  -- Phase E promotes after shadow period
  created_at             timestamptz NOT NULL DEFAULT NOW(),
  updated_at             timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (name, version)
);

DROP TRIGGER IF EXISTS trg_skill_library_updated_at ON skill_library;
CREATE TRIGGER trg_skill_library_updated_at
  BEFORE UPDATE ON skill_library
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_skill_library_active
  ON skill_library(active) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_skill_library_user
  ON skill_library(proposed_by_user_entra_id);

CREATE INDEX IF NOT EXISTS idx_skill_library_kind
  ON skill_library(kind);

ALTER TABLE skill_library ENABLE ROW LEVEL SECURITY;

-- A user can SELECT their own rows, or any row that is globally active.
DROP POLICY IF EXISTS skill_library_owner_or_active_global ON skill_library;
CREATE POLICY skill_library_owner_or_active_global ON skill_library FOR SELECT
  USING (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
    OR active = true
  );

-- A user can INSERT only their own rows.
DROP POLICY IF EXISTS skill_library_owner_insert ON skill_library;
CREATE POLICY skill_library_owner_insert ON skill_library FOR INSERT
  WITH CHECK (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
  );

-- A user can UPDATE only their own rows.
DROP POLICY IF EXISTS skill_library_owner_update ON skill_library;
CREATE POLICY skill_library_owner_update ON skill_library FOR UPDATE
  USING (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
  )
  WITH CHECK (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
  );

COMMIT;
