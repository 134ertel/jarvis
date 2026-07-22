"""Capped, persisted log of actions actually executed — not requested, not
denied, actually run. Same shape/discipline as app.memory.store's
ConversationMemory: a capped JSON list, module-level path-keyed cache with
write-through invalidation (see app.security.permissions for why this must be
keyed by path, not per-instance — the Settings UI and AIManager each
construct their own ActionLog, and both must see the same log immediately).
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict

from app.core.config import settings

MAX_STORED_ACTIONS = 200

_cache: dict[Path, list[dict]] = {}


class ActionEntry(TypedDict):
    id: str
    timestamp: str
    action: str
    detail: str
    result: str


class ActionLog:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (settings.data_dir / "action_history.json")

    def _load(self) -> list[dict]:
        if self._path in _cache:
            return _cache[self._path]
        if not self._path.exists():
            entries: list[dict] = []
        else:
            try:
                entries = json.loads(self._path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                entries = []
        _cache[self._path] = entries
        return entries

    def _save(self, entries: list[dict]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(entries, indent=2), encoding="utf-8")
        _cache[self._path] = list(entries)

    def record(self, action: str, detail: str, result: str) -> None:
        entries = list(self._load())
        entry: ActionEntry = {
            "id": uuid.uuid4().hex[:8],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "action": action,
            "detail": detail,
            "result": result,
        }
        entries.append(entry)
        self._save(entries[-MAX_STORED_ACTIONS:])

    def recent(self, limit: int = 20) -> list[dict]:
        return list(reversed(self._load()[-limit:]))

    def clear(self) -> None:
        self._save([])
