"""Dev-mode sentinel values that the runtime guards on.

These literals appear in multiple places by design:

  - This module: imported by every Python service that does
    a `_check_dsn_safety()`-style fail-closed startup guard.
  - `db/init/30_mock_eln_schema.sql` and `db/init/31_fake_logs_schema.sql`
    use these as the default password for the dev DB roles.
  - `docker-compose.yml` references the same string when wiring service
    POSTGRES_PASSWORD env vars in dev profiles.

Cycle 4 of the MCP review consolidated the *Python* copies here. The SQL
and compose copies are intentionally left in place — keeping them as
literals where they're applied (DB role creation, container env) is
clearer than threading a Python import through Make / SQL. If you ever
need to rotate this password, update:

  1. ``DEV_MOCK_ELN_READER_PASSWORD`` below
  2. ``db/init/30_mock_eln_schema.sql`` (the role creation default)
  3. ``db/init/31_fake_logs_schema.sql`` (the role creation default)
  4. ``docker-compose.yml`` (POSTGRES_PASSWORD for the dev profile)

A grep for the new value will surface any forgotten copy. The sentinel is
intentionally long and unique to make collisions with real passwords near-
impossible.
"""

from __future__ import annotations

# Default password baked into the dev/CI mock_eln_reader role. Production
# DSNs MUST override this; both mcp_eln_local and mcp_logs_sciy refuse to
# start with this value unless the operator sets the corresponding
# `*_ALLOW_DEV_PASSWORD=true` opt-in.
DEV_MOCK_ELN_READER_PASSWORD = "chemclaw_mock_eln_reader_dev_password_change_me"
