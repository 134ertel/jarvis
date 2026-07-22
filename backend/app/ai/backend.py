"""Interface every local AI backend must satisfy.

Ollama is the only backend today (see ollama_backend.py), but AIManager never
talks to Ollama's HTTP API directly — only through this interface, reached
via app.ai.backends.get_backend(). Adding a different local backend later
(LM Studio, llama.cpp's server, any other OpenAI-compatible local endpoint)
means writing one new module that satisfies this Protocol and registering it
in backends.py — AIManager itself needs no changes.
"""

from typing import Protocol


class AIBackend(Protocol):
    def is_available(self) -> bool:
        """Whether this backend is reachable right now. Checked live, not
        cached, so starting/stopping it takes effect on the very next turn."""
        ...

    def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        """One chat turn. Returns the reply as {"role", "content",
        "tool_calls"?}. Raises AIBackendError on any failure."""
        ...


class AIBackendError(Exception):
    """A backend isn't reachable, or returned something unusable."""
