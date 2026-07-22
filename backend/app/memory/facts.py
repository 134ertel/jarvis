"""Structured fact/preference memory: named key-value facts JARVIS is
explicitly told to remember (e.g. "Remember I use VS Code" -> the fact
"editor" = "VS Code"), as opposed to store.py's raw conversation transcript.

Persisted independently of conversation history, so clearing chat history
doesn't lose a taught preference, and vice versa.

Reads are cached in a module-level dict keyed by resolved path (same
discipline as app.security.permissions, for the same reason: whoever
constructs a FactMemory shouldn't matter, every instance must see the same
state immediately after a write). Every method that loads-then-mutates before
saving operates on a copy of the cached dict, never the cached object itself
— mutating it in place would corrupt the cache even before (or if) the disk
write fails.
"""

import json
from pathlib import Path
from typing import TypedDict

from app.core.config import settings

_cache: dict[Path, dict[str, "Fact"]] = {}


class Fact(TypedDict):
    key: str
    value: str


class FactMemory:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (settings.data_dir / "facts.json")

    def _load(self) -> dict[str, Fact]:
        if self._path in _cache:
            return _cache[self._path]
        if not self._path.exists():
            facts: dict[str, Fact] = {}
        else:
            try:
                facts = json.loads(self._path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                facts = {}
        _cache[self._path] = facts
        return facts

    def _save(self, facts: dict[str, Fact]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(facts, indent=2), encoding="utf-8")
        _cache[self._path] = dict(facts)

    def remember(self, key: str, value: str) -> None:
        facts = dict(self._load())
        facts[key.lower().strip()] = {"key": key.strip(), "value": value.strip()}
        self._save(facts)

    def recall(self, key: str) -> str | None:
        entry = self._load().get(key.lower().strip())
        return entry["value"] if entry else None

    def all(self) -> list[Fact]:
        return sorted(self._load().values(), key=lambda f: f["key"].lower())

    def forget(self, key: str) -> bool:
        facts = dict(self._load())
        normalized = key.lower().strip()
        if normalized in facts:
            del facts[normalized]
            self._save(facts)
            return True
        return False

    def clear(self) -> None:
        self._save({})
