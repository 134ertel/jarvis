"""FastAPI application exposed to the Electron frontend.

Owns the HTTP surface and sequences calls into the appropriate module — it holds no
reasoning, speech, or permission logic of its own. Voice conversation mostly uses
discrete REST calls (record a whole utterance, then POST it); the WebSocket is used
for exactly one thing today — pushing a wake-word detection event to the Electron
main process (see frontend/src/main/wakewordBridge.ts), since that's
backend-initiated and REST has no way to do that. See shared/ipc-contract.md for
the full contract.
"""

import asyncio
import base64
import logging
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.automation.routines import RoutineStore, validate_steps
from app.control import actions, files
from app.core.config import settings
from app.history.action_log import ActionLog
from app.memory import config as memory_config
from app.memory.facts import FactMemory
from app.security.permissions import PermissionManager, Scope

# app.ai.manager, app.voice.stt/tts/live_transcribe (pull in `faster_whisper`/
# `pyttsx3`), and app.voice.wakeword (pulls in `sounddevice`/`openwakeword`/
# `onnxruntime`) are deliberately NOT imported at module level — that would
# force those costs onto every backend boot, before uvicorn can even serve
# /health. They're imported lazily inside the handful of routes that actually
# need them, and inside the wakeword start/stop helpers below.

logger = logging.getLogger(__name__)

# The wake-word listener runs on its own background thread (see
# app.voice.wakeword), not inside FastAPI's asyncio event loop — detection has to
# hop threads to actually push a WebSocket message, via asyncio.run_coroutine_
# threadsafe against the loop captured here at startup.
_main_loop: asyncio.AbstractEventLoop | None = None
_ws_connections: set[WebSocket] = set()


def _on_wake_detected() -> None:
    # Pause immediately (synchronously, on the wake-word thread) so the same
    # phrase can't fire again mid-conversation — the frontend is responsible
    # for calling /api/voice/wakeword/resume-listening once the conversation
    # it's about to start actually ends (see that route below).
    from app.voice.wakeword import get_listener

    get_listener().pause()
    _broadcast({"event": "wake"})


def _broadcast(payload: dict) -> None:
    """Thread-safe hand-off into the asyncio event loop — callable from any
    background thread (the wake-word listener's, a periodic notification
    check, etc.), not just from within a request handler."""
    if _main_loop is not None:
        asyncio.run_coroutine_threadsafe(_send_to_all(payload), _main_loop)


async def _send_to_all(payload: dict) -> None:
    dead = set()
    for ws in _ws_connections:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.add(ws)
    _ws_connections.difference_update(dead)


def _start_wakeword_listener() -> None:
    from app.voice.wakeword import get_listener

    get_listener().start(_on_wake_detected)


def _stop_wakeword_listener() -> None:
    from app.voice.wakeword import get_listener

    get_listener().stop()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _main_loop
    _main_loop = asyncio.get_running_loop()

    from app.voice import wakeword_config

    if wakeword_config.is_wakeword_enabled():
        try:
            _start_wakeword_listener()
        except Exception:
            logger.exception("failed to start wake-word listener on startup")

    yield

    _stop_wakeword_listener()


app = FastAPI(title=settings.app_name, lifespan=_lifespan)

# Loopback-only server reached from a different origin (the Electron renderer, on
# http://localhost:5173 in dev or a file:// origin when packaged) — CORS is a
# browser-side same-origin protection, not a network exposure concern here, so
# allowing any origin is fine for a server that only ever listens on 127.0.0.1.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all for anything a route doesn't handle itself — e.g. an Ollama
    error that escapes AIManager, or an unexpected bug. FastAPI/Starlette
    registers this on ServerErrorMiddleware, a separate layer from the one
    that handles HTTPException, so deliberate 400s/404s elsewhere in this
    file are unaffected and keep their real status codes."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Something went wrong. Please try again."})


class RespondRequest(BaseModel):
    text: str


class SynthesizeRequest(BaseModel):
    text: str


class PermissionRequest(BaseModel):
    scope: str
    granted: bool


class MemoryEnabledRequest(BaseModel):
    enabled: bool


class ModelRequest(BaseModel):
    model: str


class StepPayload(BaseModel):
    type: str
    target: str = ""


class RoutinePayload(BaseModel):
    name: str
    steps: list[StepPayload]


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "app": settings.app_name}


@app.post("/api/voice/converse")
def converse(audio: bytes = Body(..., media_type="audio/wav")) -> dict:
    """Full spoken turn: audio in, transcript + spoken reply out.

    Declared as a plain `def` (not `async def`) so FastAPI runs it in its worker
    thread pool — speech recognition, the AI manager's model call, and speech
    synthesis are all blocking calls, and would otherwise stall the single
    asyncio event loop for their duration.
    """
    from app.ai.manager import get_manager
    from app.voice import stt, tts

    manager = get_manager()
    transcript = stt.transcribe(audio)
    reply = manager.respond(transcript) if transcript else "Sorry, I didn't catch that."
    reply_audio = tts.synthesize(reply)
    return {
        "transcript": transcript,
        "reply": reply,
        "audio_base64": base64.b64encode(reply_audio).decode("ascii"),
        "confirmation": manager.get_pending_confirmation(),
    }


@app.post("/api/voice/synthesize")
def synthesize_text(payload: SynthesizeRequest) -> dict:
    """Speech synthesis only, no AI/manager involvement — used for fixed
    acknowledgment phrases (e.g. the "Yes?" said right after a wake-word
    detection, see frontend's wake-word handling) that need real audio but
    aren't a conversational reply. Declared as a plain `def` since pyttsx3
    synthesis is a blocking call."""
    from app.voice import tts

    audio = tts.synthesize(payload.text)
    return {"audio_base64": base64.b64encode(audio).decode("ascii")}


@app.post("/api/ai/respond")
def respond_text(payload: RespondRequest) -> dict:
    """Typed-message turn: text in, spoken reply out (no speech recognition needed)."""
    from app.ai.manager import get_manager
    from app.voice import tts

    manager = get_manager()
    reply = manager.respond(payload.text)
    reply_audio = tts.synthesize(reply)
    return {
        "reply": reply,
        "audio_base64": base64.b64encode(reply_audio).decode("ascii"),
        "confirmation": manager.get_pending_confirmation(),
    }


@app.get("/api/ai/status")
def ai_status() -> dict:
    """Whether the AI manager is connected to a local Ollama server or running
    the pattern-matched fallback (Ollama not installed/running) — shown in
    Settings."""
    from app.ai.manager import get_manager

    return {"connected": get_manager().is_connected()}


@app.get("/api/ai/model")
def get_ai_model() -> dict:
    """Which model the current AI backend uses — shown and changeable in
    Settings."""
    from app.ai import config as ai_config

    return {"model": ai_config.get_model()}


@app.post("/api/ai/model")
def set_ai_model(payload: ModelRequest) -> dict:
    from app.ai import config as ai_config

    if not payload.model.strip():
        raise HTTPException(status_code=400, detail="model name can't be empty")
    ai_config.set_model(payload.model)
    return {"model": ai_config.get_model()}


@app.get("/api/ai/models")
def list_ai_models() -> dict:
    """Model names Ollama already has pulled locally, for the Settings model
    picker — an empty list just means Ollama isn't reachable right now, not
    an error; the picker falls back to a free-text field in that case."""
    from app.ai import ollama_backend

    return {"models": ollama_backend.list_models()}


@app.get("/api/security/permissions")
def get_permissions() -> dict:
    manager = PermissionManager()
    return {scope.value: manager.is_granted(scope) for scope in Scope}


@app.post("/api/security/permissions")
def set_permission(payload: PermissionRequest) -> dict:
    try:
        scope = Scope(payload.scope)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown scope: {payload.scope}")

    manager = PermissionManager()
    if payload.granted:
        manager.grant(scope)
    else:
        manager.revoke(scope)
    return {"scope": scope.value, "granted": manager.is_granted(scope)}


@app.get("/api/memory/enabled")
def get_memory_enabled() -> dict:
    return {"enabled": memory_config.is_memory_enabled()}


@app.post("/api/memory/enabled")
def set_memory_enabled(payload: MemoryEnabledRequest) -> dict:
    memory_config.set_memory_enabled(payload.enabled)
    return {"enabled": memory_config.is_memory_enabled()}


@app.get("/api/memory/facts")
def list_facts() -> dict:
    return {"facts": FactMemory().all()}


@app.delete("/api/memory/facts/{key}")
def delete_fact(key: str) -> dict:
    deleted = FactMemory().forget(key)
    return {"key": key, "deleted": deleted}


@app.get("/api/automations/options")
def automation_options() -> dict:
    """Whitelisted apps and personal folders available to pick from when
    building a routine's steps in the Automations page."""
    return {"apps": list(actions.WHITELISTED_APPS.keys()), "folders": list(files.SAFE_ROOTS.keys())}


@app.get("/api/automations")
def list_routines() -> dict:
    return {"routines": RoutineStore().all()}


@app.post("/api/automations")
def create_routine(payload: RoutinePayload) -> dict:
    steps = [s.model_dump() for s in payload.steps]
    error = validate_steps(steps)
    if error:
        raise HTTPException(status_code=400, detail=error)
    return {"routine": RoutineStore().create(payload.name, steps)}


@app.put("/api/automations/{routine_id}")
def update_routine(routine_id: str, payload: RoutinePayload) -> dict:
    steps = [s.model_dump() for s in payload.steps]
    error = validate_steps(steps)
    if error:
        raise HTTPException(status_code=400, detail=error)
    routine = RoutineStore().update(routine_id, payload.name, steps)
    if routine is None:
        raise HTTPException(status_code=404, detail="routine not found")
    return {"routine": routine}


@app.delete("/api/automations/{routine_id}")
def delete_routine(routine_id: str) -> dict:
    deleted = RoutineStore().delete(routine_id)
    return {"id": routine_id, "deleted": deleted}


@app.post("/api/automations/{routine_id}/run")
def run_routine(routine_id: str) -> dict:
    """Requests to run a routine — always goes through AIManager's shared
    confirmation flow, never executes directly. The UI shows this reply with
    Yes/No, then sends the user's answer through the normal /api/ai/respond
    turn, exactly like a chat-triggered "run <routine>" would."""
    from app.ai.manager import get_manager

    if RoutineStore().get(routine_id) is None:
        raise HTTPException(status_code=404, detail="routine not found")
    return {"reply": get_manager().request_run_routine(routine_id)}


@app.get("/api/history/actions")
def list_actions(limit: int = 20) -> dict:
    """Recent actions JARVIS has actually executed (not requested, not
    denied) — most-recent-first. Shown as the Settings page's "Recent
    activity" card."""
    return {"actions": ActionLog().recent(limit)}


@app.get("/api/system/telemetry")
def system_telemetry() -> dict:
    """Real hardware telemetry for the System panel — sampled fresh every
    call, never mocked. Declared as a plain `def` (not `async def`) so
    FastAPI runs it in its worker thread pool: app.control.system.get_telemetry
    blocks for ~1s to sample CPU/network over a real time window, which would
    otherwise stall the single asyncio event loop."""
    from app.control import system

    return system.get_telemetry()


class WakewordRequest(BaseModel):
    enabled: bool


@app.get("/api/voice/wakeword")
def get_wakeword() -> dict:
    """Whether always-on wake-word listening ("Hey Jarvis" / "Jarvis") is
    enabled, and whether the background listener is actually running right
    now — the Settings toggle shows both."""
    from app.voice import wakeword_config
    from app.voice.wakeword import get_listener

    listener = get_listener()
    return {
        "enabled": wakeword_config.is_wakeword_enabled(),
        "running": listener.is_running(),
        "paused": listener.is_paused(),
    }


@app.post("/api/voice/wakeword/resume-listening")
def resume_wakeword_listening() -> dict:
    """Called by the frontend once a wake-triggered conversation naturally
    ends (mutual silence, or the user manually leaves voice mode) — resumes
    reacting to the wake phrase. A no-op if wake-word isn't running at all,
    and self-heals on its own after a long timeout even if this is never
    called (see app.voice.wakeword's _MAX_PAUSE_SECONDS)."""
    from app.voice.wakeword import get_listener

    listener = get_listener()
    listener.resume()
    return {"running": listener.is_running(), "paused": listener.is_paused()}


@app.post("/api/voice/wakeword")
def set_wakeword(payload: WakewordRequest) -> dict:
    from app.voice import wakeword_config
    from app.voice.wakeword import get_listener

    wakeword_config.set_wakeword_enabled(payload.enabled)
    if payload.enabled:
        try:
            _start_wakeword_listener()
        except Exception as err:
            wakeword_config.set_wakeword_enabled(False)
            raise HTTPException(status_code=500, detail=f"Couldn't start wake-word listening: {err}")
    else:
        _stop_wakeword_listener()

    return {"enabled": wakeword_config.is_wakeword_enabled(), "running": get_listener().is_running()}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Push-only channel: the renderer connects once and stays subscribed for
    the whole session, listening for `{"event": "wake"}` when the wake-word
    listener fires. It never needs to send anything back — `receive_text()`
    just keeps the connection open until the renderer closes it."""
    await websocket.accept()
    _ws_connections.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _ws_connections.discard(websocket)


# How often to run a fresh partial-transcript pass over the rolling buffer —
# frequent enough to feel "live", not so frequent that a modest CPU is
# spending more time transcribing than the user spends talking.
_PARTIAL_INTERVAL_SECONDS = 0.5
# Keep only the trailing ~8s of audio per connection (16kHz, 16-bit mono ->
# 32000 bytes/sec) — plenty for one utterance, bounded so a connection that's
# never told "end_utterance" (e.g. the client crashed mid-sentence) can't
# grow its buffer unboundedly.
_ROLLING_BUFFER_MAX_BYTES = 16000 * 2 * 8


@app.websocket("/ws/voice/live")
async def voice_live_ws(websocket: WebSocket) -> None:
    """Live partial-transcription channel — the renderer streams small raw
    16-bit PCM frames (16kHz mono) while the user is actively speaking (see
    frontend/src/renderer/src/lib/liveTranscribeClient.ts); this runs a fast,
    approximate transcription pass over the trailing buffer roughly every
    500ms and sends back `{"event": "partial_transcript", "text": ...}`.

    This is never the source of truth for what was said — that's always
    app.voice.stt.transcribe() via the existing /api/voice/converse call once
    VAD decides the utterance is over. If this connection never opens, drops
    mid-utterance, or errors, the only visible effect is that live captions
    stop updating; the real conversation flow doesn't touch this at all.
    """
    import json
    import time

    import numpy as np

    from app.voice import live_transcribe

    await websocket.accept()
    buffer = bytearray()
    last_run = 0.0
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is not None:
                buffer.extend(data)
                if len(buffer) > _ROLLING_BUFFER_MAX_BYTES:
                    del buffer[: len(buffer) - _ROLLING_BUFFER_MAX_BYTES]
                now = time.monotonic()
                if now - last_run >= _PARTIAL_INTERVAL_SECONDS and buffer:
                    last_run = now
                    pcm = np.frombuffer(bytes(buffer), dtype=np.int16)
                    text = await asyncio.get_running_loop().run_in_executor(
                        None, live_transcribe.transcribe_partial, pcm
                    )
                    if text:
                        await websocket.send_json({"event": "partial_transcript", "text": text})
                continue
            text_msg = message.get("text")
            if text_msg is not None:
                try:
                    payload = json.loads(text_msg)
                except ValueError:
                    payload = {}
                if payload.get("event") == "end_utterance":
                    buffer.clear()
                    last_run = 0.0
    except WebSocketDisconnect:
        pass
