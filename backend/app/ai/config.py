"""Which model the local AI backend uses — user-changeable from Settings.

Persisted like app.memory.config's memory toggle: read fresh from disk on
every check, so switching models in Settings takes effect on the very next
turn, no backend restart needed.

Defaults to "llama3.1:8b". If OLLAMA_MODEL was set in backend/.env before a
model was ever chosen in Settings, that's honored as the initial default
(continuity for anyone who already configured it that way) — once a model
has been explicitly set via set_model(), the .env value no longer matters.
"""

import os

from app.settings.manager import SettingsManager

DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")

_settings = SettingsManager()


def get_model() -> str:
    return _settings.load().get("ollama_model", DEFAULT_MODEL)


def set_model(model: str) -> None:
    data = _settings.load()
    data["ollama_model"] = model.strip()
    _settings.save(data)
