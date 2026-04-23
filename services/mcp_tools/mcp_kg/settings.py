"""mcp-kg configuration."""

from pydantic_settings import SettingsConfigDict

from services.mcp_tools.common.settings import ToolSettings


class KGSettings(ToolSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = ""
    neo4j_max_pool_size: int = 20
