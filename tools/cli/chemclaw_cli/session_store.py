"""Per-user last-session-id file store.

One small file per user under `~/.chemclaw/`. The file holds a UUID
(the agent-claw session_id) and nothing else. Used by `chemclaw chat
--resume` to look up the most recent session for the current user.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_SAFE = re.compile(r"[^a-zA-Z0-9]+")


def _safe_user(user_id: str) -> str:
    return _SAFE.sub("_", user_id).strip("_") or "anon"


@dataclass(frozen=True)
class SessionStore:
    config_dir: Path

    def _path(self, user_id: str) -> Path:
        return self.config_dir / f"last-session-{_safe_user(user_id)}"

    def read(self, user_id: str) -> str | None:
        path = self._path(user_id)
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8").strip() or None

    def write(self, user_id: str, session_id: str) -> None:
        self.config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        # mkdir won't reset perms on an existing dir; do it explicitly.
        self.config_dir.chmod(0o700)
        path = self._path(user_id)
        path.write_text(session_id, encoding="utf-8")
        path.chmod(0o600)
