-- Phase A.2: harness support tables.
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- No RLS — these are system metadata tables, not user-scoped.

BEGIN;

-- ── tools ────────────────────────────────────────────────────────────────────
-- Catalog of tools the registry exposes to the agent harness.
-- source='builtin'  → execute impl is registered in-process.
-- source='mcp'      → execute impl calls mcp_url+mcp_endpoint via HTTP POST.
-- source='skill'    → execute impl delegates to a skill pack (Phase B+).

CREATE TABLE IF NOT EXISTS tools (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         text        UNIQUE NOT NULL,
  source       text        NOT NULL CHECK (source IN ('builtin','mcp','skill')),
  schema_json  jsonb       NOT NULL,
  mcp_url      text,          -- only used when source='mcp'
  mcp_endpoint text,          -- only used when source='mcp'
  description  text        NOT NULL,
  enabled      boolean     NOT NULL DEFAULT true,
  version      int         NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tools_enabled_name ON tools(enabled, name);

-- ── mcp_tools ────────────────────────────────────────────────────────────────
-- Catalog of MCP services the registry can reach.
-- Populated at startup via seed / migration; health is probed at boot.

CREATE TABLE IF NOT EXISTS mcp_tools (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name      text        UNIQUE NOT NULL,   -- e.g. 'mcp-rdkit'
  base_url          text        NOT NULL,
  enabled           boolean     NOT NULL DEFAULT true,
  last_health_check timestamptz,
  health_status     text        CHECK (health_status IN ('healthy','degraded','unknown') OR health_status IS NULL),
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

-- Explicit grants so this migration is self-contained. The global GRANT ALL
-- in 12_security_hardening.sql also covers these tables, but ONLY if 12 has
-- already been applied. When init is replayed piecemeal (operator forgot 12
-- the first time, or someone DROP'd the role and recreated it), the global
-- grant misses and the agent's `loadFromDb` crashes with permission_denied
-- on `tools`. Granting here makes the migration resilient to ordering.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tools, mcp_tools TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON tools, mcp_tools TO chemclaw_service;
  END IF;
END $$;

COMMIT;
