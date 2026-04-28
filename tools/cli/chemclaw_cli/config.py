"""Env-driven configuration for the chemclaw CLI."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_USER = "dev@local.test"
DEFAULT_AGENT_URL = "http://localhost:3101"
DEFAULT_CONFIG_DIRNAME = ".chemclaw"


@dataclass(frozen=True)
class Config:
    user: str
    agent_url: str
    config_dir: Path


def load_config() -> Config:
    """Read CHEMCLAW_* env vars with documented defaults."""
    user = os.environ.get("CHEMCLAW_USER", DEFAULT_USER)
    agent_url = os.environ.get("CHEMCLAW_AGENT_URL", DEFAULT_AGENT_URL).rstrip("/")
    config_dir_env = os.environ.get("CHEMCLAW_CONFIG_DIR")
    config_dir = Path(config_dir_env) if config_dir_env else Path.home() / DEFAULT_CONFIG_DIRNAME
    return Config(user=user, agent_url=agent_url, config_dir=config_dir)
