"""Registry of available AI backends, keyed by name.

Only "ollama" exists today. Adding a second backend later is: write a new
module satisfying app.ai.backend.AIBackend, add one line here, done —
AIManager always asks for "the current backend" through get_backend(), never
imports a specific backend module itself.
"""

from app.ai import ollama_backend
from app.ai.backend import AIBackend

_BACKENDS: dict[str, AIBackend] = {
    "ollama": ollama_backend,  # a plain module satisfies the Protocol structurally
}

DEFAULT_BACKEND = "ollama"


def get_backend(name: str = DEFAULT_BACKEND) -> AIBackend:
    return _BACKENDS[name]
