# IPC / API Contract

The single source of truth both sides (Electron and Python) agree on so the two
processes never drift out of sync. Update this file whenever a message shape changes.

## Transport

- **REST** — `http://127.0.0.1:8756/api/...` — discrete request/response calls.
  Used for voice/AI turns today: the renderer records a whole utterance (or has a
  whole typed message) before calling, rather than streaming audio continuously.
- **WebSocket** — `ws://127.0.0.1:8756/ws` — push-only channel from the backend to
  the Electron main process (not the renderer directly). Used for exactly one thing:
  broadcasting `{"event": "wake"}` when the wake-word listener fires. The client
  never needs to send anything meaningful back.
- **WebSocket** — `ws://127.0.0.1:8756/ws/voice/live` — a second, renderer-direct
  WebSocket (unlike `/ws` above) used only for live partial-transcript captions
  while voice mode is actively hearing speech. See "Voice conversation mode" below.
- Loopback-only. Never bound to `0.0.0.0`. CORS is wide open (`allow_origins=["*"]`)
  since that's a browser same-origin protection, not a network exposure concern for
  a server that only ever listens on 127.0.0.1.

## Current endpoints

| Method | Path | Body in | Body out | Purpose |
|---|---|---|---|---|
| GET | `/health` | — | `{ status, app }` | Electron polls this after spawning the backend to confirm it's ready |
| POST | `/api/voice/converse` | raw WAV bytes, `Content-Type: audio/wav` | `{ transcript, reply, audio_base64, confirmation }` | Full spoken turn: speech-to-text (`app.voice.stt`) → `app.ai.manager` → speech synthesis (`app.voice.tts`) |
| POST | `/api/ai/respond` | `{ "text": string }` | `{ reply, audio_base64, confirmation }` | Typed-message turn: same `app.ai.manager` + TTS, no speech recognition |
| GET | `/api/ai/status` | — | `{ connected: boolean }` | Whether `app.ai.manager` is connected to the current AI backend (Ollama by default) or running the pattern-matched fallback (backend not installed/running) |
| GET | `/api/ai/model` | — | `{ model: string }` | Which model the current backend uses — default `llama3.1:8b` |
| POST | `/api/ai/model` | `{ model: string }` | `{ model }` | Change the model — takes effect on the very next turn, no restart. 400 if `model` is empty. The Settings UI's "Model" field calls this |
| GET | `/api/ai/models` | — | `{ models: string[] }` | Model names Ollama already has pulled locally (via its own `/api/tags`), for the Settings model picker's suggestions — empty list (never an error) if Ollama isn't reachable |
| GET | `/api/security/permissions` | — | `{ "<scope>": boolean, ... }` | Current grant state for every `Scope` |
| POST | `/api/security/permissions` | `{ scope: string, granted: boolean }` | `{ scope, granted }` | Grant or revoke a permission scope — this is what the Settings UI's toggles call |
| GET | `/api/memory/enabled` | — | `{ enabled: boolean }` | Whether memory (conversation history + remembered facts) is on — defaults to true |
| POST | `/api/memory/enabled` | `{ enabled: boolean }` | `{ enabled }` | Turn memory on/off — the Settings "Remember things I tell you" toggle |
| GET | `/api/memory/facts` | — | `{ facts: [{ key, value }, ...] }` | Every remembered preference — this is what the Memory page lists |
| DELETE | `/api/memory/facts/{key}` | — | `{ key, deleted: boolean }` | Forget one remembered fact — the Memory page's delete button |
| GET | `/api/automations/options` | — | `{ apps: string[], folders: string[] }` | Whitelisted apps and personal folders the Automations page's step builder can pick from |
| GET | `/api/automations` | — | `{ routines: [{ id, name, steps: [{ type, target }, ...] }, ...] }` | Every saved routine |
| POST | `/api/automations` | `{ name, steps }` | `{ routine }` | Create a routine — 400 if a step is invalid (unknown type, non-whitelisted app, non-personal folder) |
| PUT | `/api/automations/{id}` | `{ name, steps }` | `{ routine }` | Replace a routine's name/steps — same validation as create, 404 if the id doesn't exist |
| DELETE | `/api/automations/{id}` | — | `{ id, deleted: boolean }` | Delete a routine |
| POST | `/api/automations/{id}/run` | — | `{ reply }` | Request to run a routine — never executes directly, sets the same pending-confirmation state as chat and returns the confirmation question. The UI then sends the user's yes/no through `/api/ai/respond`, exactly like a chat-triggered "run <routine>" would |
| GET | `/api/history/actions` | query: `limit` (default 20) | `{ actions: [{ id, timestamp, action, detail, result }, ...] }` | Actions JARVIS has actually executed (not requested, not denied), most-recent-first — the Settings page's "Recent activity" card |
| GET | `/api/system/telemetry` | — | `{ cpu_percent, cpu_temp_c, gpu_name, gpu_percent, gpu_temp_c, gpu_vram_used_mb, gpu_vram_total_mb, ram_percent, storage_percent, download_kbps, upload_kbps, network_up }` | Real hardware telemetry for the System panel, sampled fresh every call (blocks ~1s). Any field the hardware/OS can't provide is `null`, never fabricated |
| GET | `/api/voice/wakeword` | — | `{ enabled, running, paused }` | Whether wake-word listening is enabled, whether the background listener is running, and whether it's currently paused (mid wake-triggered conversation) |
| POST | `/api/voice/wakeword` | `{ enabled: boolean }` | `{ enabled, running, paused }` | Turn wake-word listening on/off — the Settings "Wake word" toggle. Starting it can fail (no mic, first-run model download failed) — a 500 with a clean detail message, and `enabled` reverts to false |
| POST | `/api/voice/wakeword/resume-listening` | — | `{ running, paused }` | Resumes reacting to the wake phrase after a wake-triggered conversation ends — called by the frontend once mutual silence (or a manual mic press) ends that conversation. Self-heals on its own after a timeout even if never called |
| POST | `/api/voice/synthesize` | `{ text: string }` | `{ audio_base64 }` | Speech synthesis only, no AI involved — used for the "Yes?" acknowledgment right after a wake-word detection |

`audio_base64` is a base64-encoded WAV clip, played directly via a `data:audio/wav`
URI in the renderer (see `frontend/src/renderer/src/lib/voiceClient.ts`) — simpler
than wiring up a second binary response channel for clips this short.

`confirmation` is either `null` or `{ kind, prompt }` — whether a risky action
(close app / organize / run routine) is now awaiting a yes/no, and the exact
question to show. Purely additive: existing clients that ignore the field are
unaffected. The frontend's shared `ConfirmDialog` component renders it as a
real modal; clicking Yes/No just sends the literal text `"yes"`/`"no"` through
another `/api/ai/respond` call — no separate confirm endpoint exists.

## Recorded audio format

The renderer captures raw PCM via the Web Audio API and encodes mono 16-bit PCM WAV
itself — this is specifically so the backend can read it straight off the wire with
Python's `wave` module (via `faster-whisper`), with no ffmpeg or transcoding step
involved.

## Voice conversation mode (continuous, hands-free)

Pressing the mic button (`frontend/src/renderer/src/components/Composer.tsx`) no
longer records one utterance — it toggles continuous "voice mode"
(`frontend/src/renderer/src/hooks/useVoiceConversation.ts`). While active: real
Voice Activity Detection (`frontend/src/renderer/src/lib/vad.ts`, wrapping
`@ricky0123/vad-web`'s Silero VAD v5 model, running in an AudioWorklet) listens
continuously and decides when the user has actually finished an utterance —
tolerating natural mid-sentence pauses via an 800ms "redemption" window, not
cutting off on every brief silence. On utterance end, VAD hands back the complete
audio segment as a Float32Array (no manual chunk accumulation needed, unlike the
old push-to-talk recorder this replaced); it's encoded to 16-bit PCM WAV
client-side and sent through the exact same `/api/voice/converse` call as before.
Once the reply is spoken, listening resumes automatically — no further button
presses — until the user presses the mic again to fully exit voice mode.

VAD's model/worklet/`onnxruntime-web` WASM assets are self-hosted under
`frontend/src/renderer/public/` (copied once from `node_modules`, not fetched
from a CDN at runtime) — consistent with this project's fully-local approach
everywhere else (Ollama, openWakeWord). `MicVAD`'s default mic-acquisition
already requests `echoCancellation`/`noiseSuppression`/`autoGainControl`, so no
extra audio-constraint work was needed on top of it.

**Interruption/barge-in**: VAD is normally paused during "thinking" (the network
round-trip), but `useVoiceConversation`'s `speakWithBargeIn` resumes it right
before starting playback of the reply (`voiceClient.ts`'s
`playBase64WavControllable`, which — unlike the plain `playBase64Wav` used by
the typed-message path — returns a real `stop()` handle) and races playback
against VAD's `onSpeechRealStart` event (a "this is genuinely sustained speech,
not a blip" signal, more reliable than the eager `onSpeechStart`). If the user
talks over JARVIS, playback is cut immediately — verified in testing to stop
within one video frame of the real-start event firing. VAD was already
mid-capturing that interrupting utterance the whole time it was running, so once
the user finishes talking it flows through the exact same `onSpeechEnd` ->
`onUtterance` path as any normal turn — no special-case "restart capture" logic
needed. `onSpeechStart`/frame-forwarding-to-live-transcribe are suppressed while
JARVIS is speaking, so a live caption never shows a transcript of JARVIS's own
voice bleeding into the mic. Barge-in reliability without real acoustic echo
cancellation depends on how much of JARVIS's own voice the mic picks up back up
off the speakers — headphones give a much cleaner result than open speakers.

**Orb audio-reactivity** (`frontend/src/renderer/src/hooks/useAudioLevel.ts`):
the orb (`AICore.tsx`, now a `forwardRef` component) reacts to real audio, not
a fixed animation loop — a live 0-1 `--core-level` CSS custom property is
written directly onto its DOM node (never through React state, since this
updates at up to ~30-60Hz and routing that through state would mean 30-60
re-renders/sec for a purely visual value). Two sources feed it: while
listening, RMS computed straight from the raw Float32Array frames VAD's
`onFrameProcessed` already hands over (no extra Web Audio graph needed for
that side); while speaking, a real `AnalyserNode` tapped onto the reply's
`Audio` element via `createMediaElementSource` (the one place an analyser is
unavoidable, since there's no other way to read a playing element's
waveform — note the analyser must stay connected between the source and
`ctx.destination`, or routing the element's output into the graph at all
would silence it). `global.css`'s `.ai-core` block defines `--core-level: 0`
as the baseline and every consuming rule (`core-glow`'s blur/color-mix,
`core-sphere`'s box-shadow spread, `core-orbit`'s opacity, `core-bars .bar`'s
height) is written via `calc()` so that a level of exactly 0 reduces to the
exact fixed value each had before this existed — idle/thinking/connecting
never call into this at all, so they're pixel-identical to before, verified
in testing. `reset()` removes the inline property entirely rather than
writing 0, since a literal 0 would otherwise permanently shadow the
stylesheet's own baseline for every future state. Also respects
`prefers-reduced-motion` (checked directly in JS before writing, plus a
`!important` CSS backstop) alongside the existing reduced-motion rules.

While voice mode is actively hearing speech (between VAD's `onSpeechStart` and
`onSpeechEnd`/misfire), every processed audio frame is also streamed to
`/ws/voice/live` (`frontend/src/renderer/src/lib/liveTranscribeClient.ts`),
which runs a fast, approximate rolling transcription
(`backend/app/voice/live_transcribe.py`, a smaller/faster Whisper model than
the authoritative one) roughly every 500ms over the trailing buffer and sends
back `{"event": "partial_transcript", "text": ...}`, shown as a provisional,
dashed-border chat bubble (`ChatArea.tsx`'s `livePartialText`) that's replaced
by the real message once `/api/voice/converse`'s actual transcript comes
back. This connection is purely a UX nicety — if it never connects or drops,
live captions just stop updating; the real turn doesn't depend on it at all.

## Engine choices (see module docstrings for the full reasoning)

- **STT** (`backend/app/voice/stt.py`): `faster-whisper`'s `small.en` model,
  fully offline and local — no API key, no account, audio never leaves the
  machine (this replaced an earlier version using SpeechRecognition's free
  Google Web Speech API, swapped out specifically to enable live partial
  transcription and lower latency, neither possible against a single-shot
  cloud API). A second, smaller/faster `tiny.en` model
  (`backend/app/voice/live_transcribe.py`) powers only the live-caption
  preview described above — never the authoritative transcript.
- **TTS** (`backend/app/voice/tts.py`): pyttsx3 over Windows SAPI5. Fully offline.
- **Understanding** (`backend/app/ai/manager.py`, via `app.ai.backends.get_backend()`):
  a local AI backend — [Ollama](https://ollama.com) by default and, today,
  the only one implemented (`ollama_backend.py`) — reached via a manual
  tool-use loop over `/api/chat`, entirely free, no API key, no account, no
  cloud model. `AIManager` never imports `ollama_backend` (or any other
  backend module) directly, only the `app.ai.backend.AIBackend` Protocol it
  satisfies, reached through `get_backend()`; adding a different local
  backend later (LM Studio, llama.cpp's server, etc.) means writing one new
  module and registering it in `app.ai.backends`, no changes to `AIManager`.
  Given recent conversation history from `app.memory` and fifteen tools:
  `get_current_time`, `get_current_date`, `open_application`,
  `close_application`, `switch_window`, `open_settings`, `search_files`,
  `find_folders`, `create_folder`, `rename_file`, `organize_folder`,
  `remember_fact`, `forget_fact`, `list_routines`, `run_routine` — defined
  once in Anthropic-style `{name, description, input_schema}` shape and
  converted to the OpenAI-style `{type, function}` shape most local backends
  (Ollama included) expect by `_to_function_calling_tools()`, so there's a
  single source of truth for what JARVIS can do, reusable by any future
  backend. Falls back to `app.ai.responder`'s plain pattern matching *plus* a
  small regex command parser for the same commands when the backend isn't
  reachable (checked live via `is_available()`, not cached) — so "Open
  Chrome", "Create a folder called Projects", "Remember I use VS Code", and
  "Run Gaming Mode" all work with zero setup, not just the free-form
  conversational commands.
- **Model selection**: which model Ollama uses is a Settings-page choice
  (`app.ai.config.get_model()`/`set_model()`, persisted like the memory
  toggle, default `llama3.1:8b`), not a `.env`-only value — `OLLAMA_MODEL` in
  `backend/.env` only seeds the very first default, before any model has
  ever been chosen in Settings. `ollama_backend.chat()` reads the current
  model fresh on every call, so switching models in Settings applies to the
  very next message, no restart. `GET /api/ai/models` (Ollama's own
  `/api/tags`) feeds the Settings picker's suggestions; typing any other
  model name is always allowed too, e.g. for a model not yet pulled.
- **Memory-as-alias-resolution**: `app.memory.facts.FactMemory` stores explicit
  preferences ("Remember I use VS Code" → fact `editor` = `VS Code`),
  independent of the raw conversation transcript in `app.memory.store`. Every
  call into `_open`/`_switch`/`_close_with_confirmation` first runs the
  requested name through `AIManager._resolve_alias()`: if it looks like "my X"
  and a fact named X is remembered, the remembered value is substituted before
  `app.control` ever sees it — so "Open my editor" resolves to "Open VS Code"
  regardless of whether Ollama or the fallback parser handled the request.
  Currently remembered facts are also injected into the system prompt each
  turn, so a connected model can reference or resolve them directly without a
  tool round trip. `app.memory.config.is_memory_enabled()` (default **on** — unlike the
  security scopes, this isn't safety-sensitive, since each fact is already
  opt-in by construction) gates all of this: off means no new facts or
  conversation turns are recorded, and existing facts stop being used for
  alias resolution or system-prompt context — but nothing already stored is
  erased. That's what deleting a fact (`DELETE /api/memory/facts/{key}`) is for.
- **Action security model**: the AI manager never executes anything itself. When
  Ollama (or the fallback parser) requests an action, the manager checks
  `app.security.permissions` for the relevant `Scope` *before* calling into
  `app.control` — an ungranted permission returns a denial string fed back into
  the conversation, never a silent no-op or a bypass. `Scope.CONTROL_LAUNCH_APP`
  gates `app.control.actions` (open/close/switch/settings); `Scope.FS_READ`
  gates read-only file search (`search_files`, `find_folders`);
  `Scope.FS_WRITE` gates anything that changes the filesystem
  (`create_folder`, `rename_file`, `organize_folder`).
- **Confirmation flow for risky actions**: closing an application, organizing
  a folder, and running an automation routine are never executed on the first
  request, even with the relevant permission granted. `AIManager` sets
  `self._pending_confirmation` (tagged with a `kind` so all three cases share
  the same mechanism) and returns a question instead; the *next* call to
  `respond()` checks for a yes/no reply before actually calling
  `app.control.actions.close_application`, `app.control.files.execute_organize`,
  or running the routine's steps. This lives entirely in `AIManager` (not
  per-mode), so it behaves identically whether Ollama is connected or not — and
  needs zero frontend changes for chat/voice, since a confirmation is just an
  ordinary back-and-forth in the existing pipeline (the Automations page's Run
  button reaches the same state a different way — see below). Every other
  action (`open_application`, `switch_window`, `open_settings`, `search_files`,
  `find_folders`, `create_folder`, `rename_file`) executes immediately once its
  permission is granted — no per-request confirmation. There is no delete
  capability exposed anywhere in the system.
- **Automation routines** (`backend/app/automation/routines.py`,
  `backend/app/ai/manager.py`): a routine is a named, ordered list of steps —
  `open_app`, `switch_window`, `open_settings`, `open_folder`, or
  `check_performance` — each one just a saved call into a capability
  `app.control` already exposes individually; a routine adds no new power, only
  a saved sequence. Closing an app and organizing a folder are deliberately
  not valid step types, since both already demand their own confirmation and
  stacking that inside an unattended multi-step run is either unsafe (skip it)
  or confusing (ask mid-routine) — leaving both out keeps every step safe to
  run once. Routines are created and edited only from the Automations page
  (`RoutineStore`, persisted like `FactMemory`, two starter routines — "Gaming
  Mode" and "Work Mode" — seeded once the first time the store is used, never
  re-seeded after, so deleting them sticks); Ollama and the fallback parser can
  only list (`list_routines`) and request to run (`run_routine`) one, never
  create one. Running a routine — whether by saying "run Gaming Mode" or
  clicking Run on the Automations page (`POST /api/automations/{id}/run`) —
  always goes through the exact same `_pending_confirmation` path described
  above: it describes every step, waits for yes/no, then executes each step in
  order through the same permission-gated helpers standalone commands use
  (`Scope.CONTROL_LAUNCH_APP` for `open_app`/`switch_window`/`open_settings`,
  `Scope.FS_READ` for `open_folder`; `check_performance`, backed by `psutil` in
  `app.control.system`, needs no permission — it only reads CPU/RAM/disk
  numbers, nothing app- or file-specific).

- **Confirmation dialog**: the reply-question flow described above is now
  paired with a real modal in the UI, not just chat text. `AIManager` stores a
  `prompt` string alongside `kind` in `self._pending_confirmation`, exposed via
  `get_pending_confirmation()` and returned as the `confirmation` field on
  every `/api/ai/respond` and `/api/voice/converse` response. One shared
  `ConfirmDialog.tsx` component renders it (used by both chat-triggered
  confirmations and the Automations page's Run button) — there's exactly one
  confirmation UI in the app, not a bespoke one per feature.
- **Action history** (`backend/app/history/action_log.py`): a capped (200),
  persisted, append-only log of actions JARVIS has *actually executed* —
  distinct from `app.memory`, which stores conversation content. Wired at the
  point of execution inside `AIManager`'s shared action helpers
  (`_open`/`_switch`/`_open_settings`/`_execute_close`/`_create_folder`/
  `_rename_file`/`_execute_organize`/`_execute_routine`) and inside
  `PermissionManager.grant`/`revoke`. Read-only queries (search/find/list) and
  memory facts aren't logged — this is an audit trail of actions with
  real-world effect, not a request log.
- **In-memory caching for every JSON store** (`app.security.permissions`,
  `app.memory.facts`, `app.memory.store`, `app.automation.routines`,
  `app.history.action_log`): each previously re-read its file from disk on
  *every* access. All five now cache in a **module-level dict keyed by
  resolved path** — not a per-instance cache — because some of these classes
  are constructed fresh per HTTP request (`app.api.server`) while others are
  held long-lived inside `AIManager`; a per-instance cache would let the
  long-lived instance see a stale value after a different instance's write.
  Every write still goes to disk first, and the cache is only updated after
  that succeeds. The one subtlety this introduces: any method that loads,
  mutates, then saves must operate on a *copy* of the loaded value — mutating
  the cached object in place would corrupt the cache before or regardless of
  whether the disk write succeeds. All five stores' create/update/forget-style
  methods were audited and fixed for this.
- **Lazy imports for startup cost**: `app.ai.manager` and `app.voice.stt`/`tts`
  (pull in `speech_recognition`/`pyttsx3`) are no longer imported at
  `app.api.server`'s module top — that forced their cost onto every backend
  boot before `/health` could even be served. They're now imported inside the
  handful of routes that actually need them. The Anthropic API and its SDK
  import cost have since been removed from the project entirely (replaced by
  `app.ai.ollama_backend`'s plain `httpx` calls to a local Ollama server), so
  this concern no longer applies to the model connection at all — only
  `speech_recognition` still benefits from staying lazy.
- **Backend health status, not a one-time check**: `frontend/src/main/
  backendManager.ts` continuously polls `/health` (~400ms, short abort
  timeout) rather than the old fire-and-forget spawn with no readiness check
  at all. Status (`starting`/`online`/`offline`/`crashed`) is pushed to the
  renderer over a `backend:status` IPC channel and also fetchable on demand
  via `backend:get-status` (needed because a view mounting well after the
  window's initial load — Settings, Automations, Memory — would otherwise
  never learn a status that already settled before it existed). The Sidebar's
  status dot and the AI core's new "connecting" visual state are both driven
  by this, replacing what used to be a hardcoded "Backend offline" label that
  never reflected reality.
- **Crash recovery**: the same poll doubles as the signal for automatic
  backend respawn. If the Python process exits unexpectedly (not via
  `stopBackend()`'s intentional stop), `backendManager.ts` respawns it with
  backoff (1s/2s/4s/8s/16s, capped at 5 attempts), resetting the attempt
  counter once continuously healthy for 30s. Exhausting all 5 attempts sets a
  terminal `crashed` status (persistent Sidebar indication + a tray balloon),
  rather than retrying forever silently.
- **Global error handling**: `app.api.server` has a catch-all
  `@app.exception_handler(Exception)` returning a clean generic 500 instead of
  a raw traceback — registered on Starlette's `ServerErrorMiddleware`, a
  separate layer from the one handling `HTTPException`, so the deliberate
  400s/404s elsewhere in this file keep their real status codes. Ollama API
  errors inside `AIManager._respond_with_ollama` are caught separately and
  turned into an in-conversation reply. On the frontend, a React
  `ErrorBoundary` wraps the whole app, and Settings/Automations/Memory
  automatically retry their initial fetch once `backend:status` reports
  `online` again, rather than being stuck on a "couldn't reach backend"
  placeholder until the user happens to navigate away and back.
- **Wake-word listening** (`backend/app/voice/wakeword.py`, `wakeword_config.py`):
  off by default, like the security permission scopes — a real behavior change
  (a background microphone stream) rather than a passive setting. Detection is
  fully local via openWakeWord's pretrained `hey_jarvis` model (ONNX, ~10MB,
  fetched once from GitHub releases on first enable — same one-time-fetch-then-
  offline shape as pulling an Ollama model); scores 0.97–0.999 on both "Hey
  Jarvis" and bare "Jarvis" in testing, effectively zero on unrelated speech.
  `sounddevice` captures a continuous 16kHz mono stream on its own background
  thread (distinct from the renderer's push-to-talk recording); on detection,
  a cooldown (2.5s) prevents one utterance from firing twice. The listener is
  a module-level singleton (`get_listener()`), started/stopped by the
  `/api/voice/wakeword` routes and auto-started on backend boot if enabled
  persisted from a previous session. `sounddevice`/`openwakeword` (and its
  `onnxruntime` dependency) are imported lazily inside `start()`, not at
  module load, matching this file's other lazy-import choices.
  Detection can't reach the renderer over REST (nothing initiates the
  request), so this is what the WebSocket is actually for: `app.api.server`
  captures the running asyncio loop at startup (`_lifespan`) and bridges the
  wake-word background thread's callback into it via
  `asyncio.run_coroutine_threadsafe`, broadcasting `{"event": "wake"}` to
  every connected WebSocket client. The *Electron main process* — not the
  renderer — is that client (`frontend/src/main/wakewordBridge.ts`, reconnects
  on drop). Unlike the tray's "Activate Assistant" (`assistant:activate`,
  toggles voice mode), a wake detection fires a distinct `wake:triggered` IPC
  event (`index.ts`'s `handleWakeWordTriggered`) — deliberately not reused,
  since a wake should always *start* a conversation, never toggle one off,
  and needs different UI behavior (chime + "Yes?" + auto-return-on-silence)
  than a manual press.

  The instant a wake fires, `_on_wake_detected` synchronously calls
  `get_listener().pause()` *before* broadcasting — the same phrase can't fire
  again mid-conversation, since the model stops running on incoming frames
  (the mic stream itself stays open; `pause()`/`resume()` are cheap, unlike a
  full `stop()`/`start()` which reloads the model). On the frontend,
  `HomeView.tsx`'s `onWakeTriggered` handler plays a synthesized chime
  (`lib/chime.ts`, generated via Web Audio oscillators, no bundled sound
  file), speaks a quick "Yes?" (`POST /api/voice/synthesize`, since the
  phrase is fixed and doesn't need to go through `AIManager`), then calls
  `useVoiceConversation`'s `startFromWakeWord()` — the same continuous
  listen/VAD/barge-in machinery as a manual voice-mode session, plus a
  silence watchdog: after `SILENCE_TIMEOUT_MS` (7s) with no speech from
  either side, voice mode exits automatically and calls
  `POST /api/voice/wakeword/resume-listening`, which is what lets the wake
  phrase work again for the *next* conversation. Manual voice mode
  (`toggleVoiceMode`) never uses this timeout — it stays on until the user
  presses the mic again, per spec; only wake-triggered sessions auto-return.
  If the resume call is ever missed entirely (e.g. the app crashes
  mid-conversation), `wakeword.py`'s own `_MAX_PAUSE_SECONDS` (5 minutes)
  force-resumes detection regardless, so a dropped signal can't permanently
  wedge wake-word listening until a restart.
- **Update system**: `electron-updater`, wired but pointed at a placeholder
  GitHub repo in `package.json`'s `build.publish` — real update checks/
  installs need the project's actual repo filled in first. Guarded behind
  `app.isPackaged` (a no-op in dev, by design). `autoDownload` is off — the
  user explicitly triggers a download from the new Settings "Updates" card,
  which also shows the current version (`app.getVersion()` via preload) and a
  progress/"restart to update" state once one is downloaded.

Each module (memory, settings) will add its own routes under `/api/<module>/...`
as more of it is built out.
