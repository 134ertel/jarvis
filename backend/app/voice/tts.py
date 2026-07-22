"""Text-to-speech.

Engine choice: pyttsx3, which wraps Windows' built-in SAPI5 voices — fully offline,
no network calls, no API keys, and matches this project's Windows-only target.
Swap the body of `synthesize` for a different engine later without touching any
other module — everything else only depends on this function's signature (text in,
WAV bytes out).

A fresh engine instance is created per call rather than reused: pyttsx3's Windows
driver is known to hang on a second run_and_wait() against the same engine instance
in some versions, and synthesis is infrequent enough here that the extra init cost
doesn't matter.
"""

import os
import tempfile

import pyttsx3


def synthesize(text: str) -> bytes:
    """Synthesizes `text` to speech, returning WAV audio bytes."""
    engine = pyttsx3.init()
    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        engine.save_to_file(text, tmp_path)
        engine.runAndWait()
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        engine.stop()
        os.unlink(tmp_path)
