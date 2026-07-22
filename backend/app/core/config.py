"""Process-wide configuration.

This is distinct from app.settings, which stores *user-facing* preferences on disk.
This module holds low-level, non-user-facing constants such as the loopback port the
backend listens on and the app's data directory.
"""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    port: int = 8756
    app_name: str = "JARVIS"
    data_dir: Path = Path.home() / "AppData" / "Local" / "JARVIS"
    # Local Ollama server host (see app.ai.ollama_backend) — overridable from
    # backend/.env for anyone running Ollama elsewhere. Which *model* to use
    # is user-facing (changeable from Settings) and lives in app.ai.config
    # instead, not here.
    ollama_host: str = os.environ.get("OLLAMA_HOST", "http://localhost:11434")


settings = Settings()
