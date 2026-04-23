"""Config for the doc_ingester."""

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class IngesterSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw"
    postgres_password: str = ""

    # Root directory scanned by the ingester. Files outside this root are
    # rejected — this is the only defence against a misconfigured mount
    # pointing at the filesystem root.
    docs_root: Path = Path("./sample-data/documents")

    # Reject individual files larger than this.
    max_file_bytes: int = 128 * 1024 * 1024  # 128 MiB

    # Chunking parameters (characters; we don't tokenize here).
    chunk_size_chars: int = 2500
    chunk_overlap_chars: int = 250

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )
