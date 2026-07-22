"""Speech-to-text.

Engine choice: faster-whisper (CTranslate2), running the "small.en" model
fully offline and locally — no API key, no account, and after the one-time
model download (fetched from Hugging Face on first use, cached locally like
Ollama's models or openWakeWord's), no audio ever leaves the machine. This
replaced an earlier version backed by SpeechRecognition's free Google Web
Speech API specifically to enable live partial transcription (see
live_transcribe.py) and lower latency — a cloud, single-shot-only API can't
do either.

The `faster_whisper` import (and the WhisperModel it constructs, which reads
model weights from disk) is deferred until the first real transcription
instead of paid at module-import time — every user of typed chat never
needs voice at all, so there's no reason to make backend startup wait on it.
"""

import io

_model = None


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel("small.en", device="cpu", compute_type="int8")
    return _model


def transcribe(wav_bytes: bytes) -> str:
    """Transcribes a mono 16-bit PCM WAV clip to text.

    Returns "" if the clip was empty/silent or had no recognizable speech,
    rather than raising — an unrecognized utterance is a normal outcome for
    a voice assistant, not an error. `vad_filter=True` uses Whisper's own
    bundled Silero VAD to skip non-speech stretches, which also curbs the
    model's known tendency to hallucinate short phrases from pure silence.
    """
    model = _get_model()
    try:
        segments, _info = model.transcribe(
            io.BytesIO(wav_bytes), language="en", beam_size=5, vad_filter=True
        )
        return " ".join(segment.text.strip() for segment in segments).strip()
    except Exception:
        return ""
