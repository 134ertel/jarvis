"""Foundation for reading and writing the on-disk settings file.

No settings schema is defined yet — this only establishes where and how settings are
persisted so later modules have a single place to read/write through.
"""

import json
from pathlib import Path
from typing import Any

from app.core.config import settings as core_settings


class SettingsManager:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (core_settings.data_dir / "settings.json")

    def load(self) -> dict[str, Any]:
        if not self._path.exists():
            return {}
        return json.loads(self._path.read_text(encoding="utf-8"))

    def save(self, data: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(data, indent=2), encoding="utf-8")
