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
    postgres_user: str = "chemclaw"
    postgres_password: str = ""

    agent_host: str = "localhost"
    agent_port: int = 3100

    # AGENT_BASE_URL overrides agent_host + agent_port when set.
    # Flip to point at agent-claw (Phase A.4+):
    #   AGENT_BASE_URL=http://localhost:3101 streamlit run services/frontend/streamlit_app.py
    agent_base_url: str = ""

    chemclaw_dev_mode: bool = True
    chemclaw_dev_user_email: str = "dev@local.test"
    chemclaw_dev_user_projects: str = "NCE-001,NCE-002"

    @property
    def resolved_agent_base_url(self) -> str:
        if self.agent_base_url:
            return self.agent_base_url.rstrip("/")
        return f"http://{self.agent_host}:{self.agent_port}"

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


@lru_cache(maxsize=1)
def get_settings() -> FrontendSettings:
    return FrontendSettings()
