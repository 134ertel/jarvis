"""Storage and validation for user-created automation routines.

A routine is just a named, ordered list of steps, where each step is one of
the actions app.control already exposes individually (open an app, switch to
it, open Settings, open a personal folder, check performance) — a routine
doesn't add any new capability, it's a saved sequence of existing ones.

Closing an app and organizing a folder are deliberately NOT valid step types.
Both already require their own explicit confirmation when run on their own;
letting them into an unattended multi-step routine would mean either silently
skipping that confirmation (unsafe) or interrupting the routine mid-run to ask
(confusing). Leaving both out keeps every step here safe to run once the
routine itself has been confirmed — see app.ai.manager's confirmation flow,
which every routine run still goes through regardless.

Two starter routines are seeded the first time this store is used (never
re-seeded after that, so deleting them sticks) — see _DEFAULT_ROUTINES.

Reads are cached in a module-level dict keyed by resolved path (same
discipline as app.security.permissions and app.memory.facts). `create`
copies the loaded list before appending; `update` copies both the list *and*
the specific routine dict before mutating it in place — otherwise either
would corrupt the cache (or, on first-ever seed, the module-level
_DEFAULT_ROUTINES constant itself) before/regardless of whether the disk
write succeeds. `delete`'s list comprehension already builds a fresh list,
so it needs no change.
"""

import json
import uuid
from pathlib import Path
from typing import TypedDict

from app.control import actions, files
from app.core.config import settings

_cache: dict[Path, list["Routine"]] = {}

STEP_TYPES = ("open_app", "switch_window", "open_settings", "open_folder", "check_performance")

# Step types that don't take a target — anything else must name a whitelisted
# app (open_app/switch_window) or a personal folder (open_folder).
_NO_TARGET_STEPS = {"open_settings", "check_performance"}


class Step(TypedDict):
    type: str
    target: str


class Routine(TypedDict):
    id: str
    name: str
    steps: list[Step]


_DEFAULT_ROUTINES: list[Routine] = [
    {
        "id": "gaming-mode",
        "name": "Gaming Mode",
        "steps": [
            {"type": "open_app", "target": "discord"},
            {"type": "open_app", "target": "steam"},
            {"type": "check_performance", "target": ""},
        ],
    },
    {
        "id": "work-mode",
        "name": "Work Mode",
        "steps": [
            {"type": "open_app", "target": "chrome"},
            {"type": "open_folder", "target": "documents"},
            {"type": "open_app", "target": "vs code"},
        ],
    },
]


def validate_steps(steps: list[dict]) -> str | None:
    """Returns an error message if `steps` isn't a valid routine body, else None."""
    if not steps:
        return "A routine needs at least one step."
    for step in steps:
        step_type = step.get("type")
        if step_type not in STEP_TYPES:
            return f"Unknown step type: {step_type}"
        target = (step.get("target") or "").strip()
        if step_type in _NO_TARGET_STEPS:
            continue
        if not target:
            return f"'{step_type}' needs a target."
        if step_type in ("open_app", "switch_window") and target.lower() not in actions.WHITELISTED_APPS:
            return f"'{target}' is not a whitelisted application."
        if step_type == "open_folder" and target.lower() not in files.SAFE_ROOTS:
            return f"'{target}' is not a folder JARVIS can open."
    return None


class RoutineStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (settings.data_dir / "automations.json")

    def _load(self) -> list[Routine]:
        if self._path in _cache:
            return _cache[self._path]
        if not self._path.exists():
            self._save(_DEFAULT_ROUTINES)
            return _cache[self._path]
        try:
            routines = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            routines = []
        _cache[self._path] = routines
        return routines

    def _save(self, routines: list[Routine]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(routines, indent=2), encoding="utf-8")
        _cache[self._path] = [dict(r) for r in routines]

    def all(self) -> list[Routine]:
        return self._load()

    def get(self, routine_id: str) -> Routine | None:
        return next((r for r in self._load() if r["id"] == routine_id), None)

    def get_by_name(self, name: str) -> Routine | None:
        normalized = name.strip().lower()
        return next((r for r in self._load() if r["name"].strip().lower() == normalized), None)

    def create(self, name: str, steps: list[Step]) -> Routine:
        routines = list(self._load())
        routine: Routine = {"id": uuid.uuid4().hex[:8], "name": name.strip(), "steps": steps}
        routines.append(routine)
        self._save(routines)
        return routine

    def update(self, routine_id: str, name: str, steps: list[Step]) -> Routine | None:
        routines = [dict(r) for r in self._load()]
        for routine in routines:
            if routine["id"] == routine_id:
                routine["name"] = name.strip()
                routine["steps"] = steps
                self._save(routines)
                return routine
        return None

    def delete(self, routine_id: str) -> bool:
        routines = self._load()
        remaining = [r for r in routines if r["id"] != routine_id]
        if len(remaining) == len(routines):
            return False
        self._save(remaining)
        return True
