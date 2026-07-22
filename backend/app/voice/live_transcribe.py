"""Fast, best-effort rolling transcription for live captions while the user
is still speaking — a much smaller/faster model than app.voice.stt's
authoritative one, since this runs repeatedly (roughly every 500ms, see
app.api.server's /ws/voice/live) over a growing buffer rather than once per
utterance. Never the source of truth: the real transcript always comes from
app.voice.stt.transcribe() once VAD decides the utterance is over — this
only powers the live caption text shown while the user is still talking.

Lazy-loaded module-level singleton, matching app.voice.stt/wakeword's
established discipline.
"""

import numpy as np

_model = None

# Below this many samples (~100ms at 16kHz) there isn't enough audio for a
# useful partial guess — skip running the model at all.
_MIN_SAMPLES = 1600


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
    return _model


def transcribe_partial(pcm_int16: np.ndarray) -> str:
    """`pcm_int16` is mono 16kHz int16 samples. Returns a best-effort partial
    transcript — fast and approximate, not authoritative, never raises."""
    if len(pcm_int16) < _MIN_SAMPLES:
        return ""
    audio_float32 = pcm_int16.astype(np.float32) / 32768.0
    model = _get_model()
    try:
        segments, _info = model.transcribe(
            audio_float32,
            language="en",
            beam_size=1,
            without_timestamps=True,
            condition_on_previous_text=False,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()
    except Exception:
        return ""
