"""Common settings base class for MCP tool services."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class ToolSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"
