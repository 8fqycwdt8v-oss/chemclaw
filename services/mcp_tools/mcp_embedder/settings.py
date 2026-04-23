"""mcp-embedder configuration."""

from pydantic_settings import SettingsConfigDict

from services.mcp_tools.common.settings import ToolSettings


class EmbedderSettings(ToolSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # BGE-M3 is the default. Can be swapped to a smaller model for dev.
    embed_model_name: str = "BAAI/bge-m3"

    # Device: "cpu", "cuda", or "auto"
    embed_device: str = "cpu"

    # HuggingFace cache dir — for air-gapped envs, pre-populate and mount.
    hf_home: str | None = None
