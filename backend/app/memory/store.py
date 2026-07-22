"""Conversation memory.

Persists chat turns to disk so the assistant retains context across restarts,
not just within one process's lifetime — this is what "remember conversations"
actually means here. Deliberately simple: a capped JSON list, not a semantic or
vector store. Good enough to hand recent turns back to the AI manager as
context; upgrading to something smarter later shouldn't require callers to
change.

Reads are cached in a module-level dict keyed by resolved path (same
discipline as app.security.permissions/app.memory.facts/app.automation.routines).
`add_turn` copies the loaded list before appending — the final
`[-MAX_STORED_TURNS:]` slice handed to `_save` is already a fresh list, but
the `.append()` right before it isn't, and would otherwise mutate the cached
list in place before the write even happens.
"""

import json
from pathlib import Path
from typing import Literal

from app.core.config import settings

MAX_STORED_TURNS = 200
DEFAULT_CONTEXT_TURNS = 12

Role = Literal["user", "assistant"]

_cache: dict[Path, list[dict]] = {}


class ConversationMemory:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (settings.data_dir / "conversation_history.json")

    def _load(self) -> list[dict]:
        if self._path in _cache:
            return _cache[self._path]
        if not self._path.exists():
            turns: list[dict] = []
        else:
            try:
                turns = json.loads(self._path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                turns = []
        _cache[self._path] = turns
        return turns

    def _save(self, turns: list[dict]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(turns, indent=2), encoding="utf-8")
        _cache[self._path] = list(turns)

    def add_turn(self, role: Role, text: str) -> None:
        turns = list(self._load())
        turns.append({"role": role, "text": text})
        self._save(turns[-MAX_STORED_TURNS:])

    def recent_messages(self, limit: int = DEFAULT_CONTEXT_TURNS) -> list[dict]:
        """Recent turns shaped as chat-message entries (role/content) — the
        shape Ollama's /api/chat (and most chat-completion APIs) expect."""
        turns = self._load()[-limit:]
        return [{"role": t["role"], "content": t["text"]} for t in turns]

    def clear(self) -> None:
        self._save([])
