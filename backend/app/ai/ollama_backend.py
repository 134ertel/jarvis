"""Ollama backend — JARVIS's default (and, today, only) local AI backend.
Satisfies the app.ai.backend.AIBackend Protocol; see that module for why
AIManager never imports this module directly, only through
app.ai.backends.get_backend().

Fully local and free — no API key, no account, no network egress beyond the
user's own machine (Ollama listens on 127.0.0.1 by default).

Ollama's `/api/chat` supports the same style of tool-calling used here
(OpenAI/Anthropic-style function-calling): a `tools` list shaped as
`{"type": "function", "function": {"name", "description", "parameters"}}`,
and a response whose `message` may include `tool_calls`, each with
already-parsed (not JSON-string) arguments.

If Ollama isn't installed or isn't running, every call here fails fast
(short timeout on the availability check) rather than hanging — AIManager
catches AIBackendError and falls back to the regex/pattern-matched responder,
so JARVIS always opens and answers *something*, just less capably.
"""

import httpx

from app.ai import config as ai_config
from app.ai.backend import AIBackendError
from app.core.config import settings

# Just "is it there" — must stay short so a missing Ollama install doesn't
# make every single turn wait around before falling back.
_PING_TIMEOUT = 2.0

# Local generation can genuinely take a while on modest hardware or a larger
# model — this only bounds a hung request, not normal (if slow) inference.
_CHAT_TIMEOUT = 60.0

# Keeps voice replies short by default; SYSTEM_PROMPT already asks the model
# for brevity, this is just a backstop against a runaway generation.
_NUM_PREDICT = 512


def is_available() -> bool:
    """Whether a local Ollama server is currently reachable. Cheap, real-time
    check — not cached — so JARVIS notices Ollama starting or stopping
    without needing a restart."""
    try:
        with httpx.Client(timeout=_PING_TIMEOUT) as client:
            response = client.get(f"{settings.ollama_host}/api/tags")
            return response.status_code == 200
    except httpx.HTTPError:
        return False


def list_models() -> list[str]:
    """Model names Ollama already has pulled locally, for the Settings model
    picker. Never raises — an empty list just means "couldn't ask" (Ollama
    unreachable), which the UI treats as "type a model name yourself"."""
    try:
        with httpx.Client(timeout=_PING_TIMEOUT) as client:
            response = client.get(f"{settings.ollama_host}/api/tags")
            response.raise_for_status()
            return [m["name"] for m in response.json().get("models", [])]
    except (httpx.HTTPError, KeyError, ValueError):
        return []


def chat(messages: list[dict], tools: list[dict] | None = None) -> dict:
    """One /api/chat turn against whatever model is currently configured
    (app.ai.config.get_model(), user-changeable from Settings — read fresh
    here, not cached, so a model switch applies on the very next turn).
    Returns the response's `message` dict (`{"role", "content",
    "tool_calls"?}`). Raises AIBackendError on any connection failure,
    timeout, or malformed response."""
    payload: dict = {
        "model": ai_config.get_model(),
        "messages": messages,
        "stream": False,
        "options": {"num_predict": _NUM_PREDICT},
    }
    if tools:
        payload["tools"] = tools

    try:
        with httpx.Client(timeout=_CHAT_TIMEOUT) as client:
            response = client.post(f"{settings.ollama_host}/api/chat", json=payload)
            response.raise_for_status()
            return response.json()["message"]
    except (httpx.HTTPError, KeyError, ValueError) as err:
        raise AIBackendError(str(err)) from err
