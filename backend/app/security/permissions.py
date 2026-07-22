"""Foundation for permission scopes and enforcement.

Defines the set of scopes other modules request grants for. Persisted to a JSON
file (not just in-memory) so grants survive a backend restart and can be
controlled from the Settings UI via the /api/security/permissions endpoints —
see app.api.server. Defaults to denying everything, which is the correct default
for an assistant that can act on the user's computer.

Reads are cached in a module-level dict keyed by resolved path, not per
PermissionManager instance — `AIManager` holds one long-lived instance while
app.api.server constructs a fresh one per request, so a per-instance cache
would go stale the moment Settings toggles a permission through a different
instance. Keying by path means every instance, wherever constructed, shares
the same view and sees a write immediately. Every write goes to disk first;
the cache is only updated after that succeeds, so a failed write never leaves
a phantom value behind.
"""

import json
from enum import Enum
from pathlib import Path

from app.core.config import settings as core_settings
from app.history.action_log import ActionLog

_cache: dict[Path, set[str]] = {}
_history = ActionLog()


class Scope(str, Enum):
    CONTROL_MOUSE = "control.mouse"  # not used yet
    CONTROL_KEYBOARD = "control.keyboard"  # not used yet
    CONTROL_LAUNCH_APP = "control.launch_app"  # app.control.actions: open/close/switch/settings
    FS_READ = "fs.read"  # app.control.files: search_files, find_folders
    FS_WRITE = "fs.write"  # app.control.files: create_folder, rename_file, organize_folder


class PermissionManager:
    """Default-deny gate. Every module that can act on the OS must ask here first."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (core_settings.data_dir / "permissions.json")

    def _load(self) -> set[str]:
        if self._path in _cache:
            return _cache[self._path]
        if not self._path.exists():
            granted: set[str] = set()
        else:
            try:
                granted = set(json.loads(self._path.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                granted = set()
        _cache[self._path] = granted
        return granted

    def _save(self, granted: set[str]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(sorted(granted), indent=2), encoding="utf-8")
        _cache[self._path] = set(granted)

    def is_granted(self, scope: Scope) -> bool:
        return scope.value in self._load()

    def grant(self, scope: Scope) -> None:
        granted = set(self._load())
        granted.add(scope.value)
        self._save(granted)
        _history.record("permission_granted", scope.value, "Granted")

    def revoke(self, scope: Scope) -> None:
        granted = set(self._load())
        granted.discard(scope.value)
        self._save(granted)
        _history.record("permission_revoked", scope.value, "Revoked")
