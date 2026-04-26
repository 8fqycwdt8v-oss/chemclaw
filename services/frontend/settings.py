"""Frontend configuration.

All settings come from environment variables (dev-loaded from .env).
Do not hardcode credentials or project identifiers.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class FrontendSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    # The frontend connects as chemclaw_app (LOGIN, NO BYPASSRLS) so every
    # read is RLS-enforced against the calling user's project membership.
    # Backward-compat: falls back to postgres_user / postgres_password if
    # the chemclaw_app_* vars are unset.
    chemclaw_app_user: str = "chemclaw_app"
    chemclaw_app_password: str = ""
    postgres_user: str = "chemclaw"
    postgres_password: str = ""

    agent_host: str = "localhost"
    # Phase F.2: default port is now 3101 (agent-claw). Legacy services/agent/ deleted.
    agent_port: int = 3101

    # AGENT_BASE_URL overrides agent_host + agent_port when set.
    agent_base_url: str = ""

    chemclaw_dev_mode: bool = True
    chemclaw_dev_user_email: str = "dev@local.test"
    chemclaw_dev_user_projects: str = "NCE-001,NCE-002"

    # Langfuse — for "View trace" links (Phase D.2).
    # Set LANGFUSE_HOST to the Langfuse UI base URL (e.g. http://localhost:3000).
    langfuse_host: str = ""

    @property
    def resolved_agent_base_url(self) -> str:
        if self.agent_base_url:
            return self.agent_base_url.rstrip("/")
        return f"http://{self.agent_host}:{self.agent_port}"

    @property
    def postgres_dsn(self) -> str:
        # Prefer the dedicated app role.
        user = self.chemclaw_app_user or self.postgres_user
        password = self.chemclaw_app_password or self.postgres_password
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={user} password={password}"
        )


@lru_cache(maxsize=1)
def get_settings() -> FrontendSettings:
    return FrontendSettings()
