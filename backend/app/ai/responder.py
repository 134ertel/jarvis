"""Minimal command understanding.

This is NOT a language model — it's a small set of pattern-matched commands, just
enough to make the voice pipeline demonstrably work end-to-end (e.g. the classic
"what time is it?" example). Real reasoning — an LLM call, an intent classifier,
tool use — replaces `respond` later; nothing else in the system depends on how this
function decides its answer, only on its signature (text in, text out), so that
swap won't touch app.voice or the API layer.
"""

from datetime import datetime


def respond(text: str) -> str:
    lowered = text.lower().strip()

    if not lowered:
        return "Sorry, I didn't catch that."

    if any(greeting in lowered for greeting in ("hello", "hi jarvis", "hey jarvis", "hi there")):
        return "Hello! How can I help you?"

    if "time" in lowered:
        now = datetime.now().strftime("%I:%M %p").lstrip("0")
        return f"The current time is {now}."

    if "date" in lowered or "day is it" in lowered:
        today = datetime.now().strftime("%A, %B %d")
        return f"Today is {today}."

    if "who are you" in lowered or "what are you" in lowered:
        return "I'm JARVIS, your personal assistant."

    return f'I heard you say: "{text}", but I don\'t know how to respond to that yet.'
