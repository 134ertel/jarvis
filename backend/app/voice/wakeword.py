"""Local, always-on wake-word detection ("Hey Jarvis" or just "Jarvis") via
openWakeWord's pretrained model. Audio never leaves the machine — this is a
continuous local microphone stream distinct from the push-to-talk recording
the renderer does for an actual command; this module only listens for the
wake phrase, then hands off to a caller-supplied callback (app.api.server
wires that callback to push a WebSocket event, which triggers the same
continuous voice-conversation loop a manual mic press starts). `pause()`/
`resume()` let a wake-triggered conversation temporarily stop the listener
from reacting without fully tearing down the microphone stream/model — see
app.api.server's wake handling and the /api/voice/wakeword/resume-listening
route.

The pretrained model's small (~10MB total) ONNX files are fetched once from
openWakeWord's GitHub releases the first time this ever runs — that one
download needs an internet connection; every run after that is fully local,
same one-time-fetch-then-offline shape as pulling an Ollama model.

Both `sounddevice` and `openwakeword` (and its onnxruntime dependency) are
imported lazily inside start(), not at module level — this module is only
ever touched when wake-word listening is actually enabled, and importing
onnxruntime unconditionally would add real startup cost to every backend
boot for a feature most sessions won't use.
"""

import logging
import queue
import threading
import time
from typing import Callable, Optional

import numpy as np

logger = logging.getLogger(__name__)

_SAMPLE_RATE = 16000
_FRAME_SAMPLES = 1280  # 80ms at 16kHz — openWakeWord's expected chunk size
_SCORE_THRESHOLD = 0.5
_COOLDOWN_SECONDS = 2.5  # ignore retriggers right after a detected wake, so one utterance can't fire twice
_MODEL_NAME = "hey_jarvis"

# Safety net for pause(): if whatever's supposed to call resume() never does
# (a renderer crash mid-conversation, a missed IPC message), wake-word
# detection would otherwise stay paused until the backend restarts. This
# forces it back on regardless, after a generous grace period no real
# conversation should ever need.
_MAX_PAUSE_SECONDS = 300


class WakeWordListener:
    """One instance per backend process — see get_listener() below."""

    def __init__(self) -> None:
        self._stream = None
        self._model = None
        self._queue: "queue.Queue[np.ndarray]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._on_wake: Optional[Callable[[], None]] = None
        self._last_trigger = 0.0
        self._lock = threading.Lock()
        self._paused = False
        self._paused_at: Optional[float] = None

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def is_paused(self) -> bool:
        return self._paused

    def pause(self) -> None:
        """Stops running the model on incoming frames without tearing down
        the microphone stream — cheap enough to hold for a whole conversation,
        unlike stop()/start() which fully releases the device and reloads the
        model. Used while a wake-triggered conversation is in progress, so
        the same wake phrase can't fire again mid-conversation."""
        self._paused = True
        self._paused_at = time.monotonic()

    def resume(self) -> None:
        self._paused = False
        self._paused_at = None
        # Reset the cooldown so residual/queued audio from just before pausing
        # can't immediately re-trigger the instant detection resumes.
        self._last_trigger = time.monotonic()

    def start(self, on_wake: Callable[[], None]) -> None:
        """Starts the background microphone stream + detection loop. Safe to
        call if already running (no-op). Raises if the model/mic can't be
        set up (no mic present, first-run download failed, etc.) — the
        caller (app.api.server) turns that into a clean error response
        rather than leaving a half-started listener around."""
        with self._lock:
            if self.is_running():
                return

            import sounddevice as sd
            import openwakeword
            from openwakeword.model import Model

            openwakeword.utils.download_models([_MODEL_NAME])
            self._model = Model(wakeword_models=[_MODEL_NAME])
            self._on_wake = on_wake
            self._stop_event.clear()
            self._last_trigger = 0.0

            def _callback(indata, _frames, _time_info, _status) -> None:
                self._queue.put(indata[:, 0].copy())

            self._stream = sd.InputStream(
                samplerate=_SAMPLE_RATE,
                channels=1,
                dtype="int16",
                blocksize=_FRAME_SAMPLES,
                callback=_callback,
            )
            self._stream.start()
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                frame = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if self._paused:
                if self._paused_at is not None and time.monotonic() - self._paused_at > _MAX_PAUSE_SECONDS:
                    logger.warning("wake-word listener force-resumed after exceeding max pause duration")
                    self.resume()
                else:
                    continue  # drain the queue without running predict() while paused
            try:
                prediction = self._model.predict(frame)
            except Exception:
                logger.exception("wake-word model prediction failed")
                continue
            score = prediction.get(_MODEL_NAME, 0.0)
            if score < _SCORE_THRESHOLD:
                continue
            now = time.monotonic()
            if now - self._last_trigger < _COOLDOWN_SECONDS:
                continue
            self._last_trigger = now
            self._model.reset()
            if self._on_wake is not None:
                try:
                    self._on_wake()
                except Exception:
                    logger.exception("wake-word callback failed")

    def stop(self) -> None:
        with self._lock:
            self._stop_event.set()
            if self._stream is not None:
                self._stream.stop()
                self._stream.close()
                self._stream = None
            if self._thread is not None:
                self._thread.join(timeout=2)
                self._thread = None
            self._model = None
            self._paused = False
            self._paused_at = None
            with self._queue.mutex:
                self._queue.queue.clear()


_listener = WakeWordListener()


def get_listener() -> WakeWordListener:
    return _listener
