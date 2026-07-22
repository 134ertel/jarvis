# JARVIS — Architecture

## Overview

JARVIS is a Windows desktop AI assistant built as two cooperating processes:

- **`frontend/`** — Electron + React + TypeScript. Owns the window, OS-level integration
  (tray, autostart, global shortcuts), and renders the UI. Contains no AI, voice, or
  automation logic.
- **`backend/`** — Python (FastAPI). Owns all "intelligence": AI reasoning, voice,
  computer control, memory, settings, and permission enforcement.

The two communicate over a **loopback-only** HTTP + WebSocket API (`127.0.0.1`, never
exposed to the network). Electron's main process spawns the Python process as a child,
waits for a health check, then the renderer talks to it exclusively through a
preload-exposed bridge:

- REST → discrete calls (settings CRUD, permission grants, one-shot queries)
- WebSocket → streaming (voice audio, live assistant responses)

### Why two processes instead of one

Python has the mature ecosystem for AI inference, speech processing, and OS automation.
Keeping that out of the Electron/Node process means:

1. Electron stays focused on window/OS shell concerns.
2. The process boundary is also a **security boundary** — the renderer (which renders
   web-style content) can never reach the OS directly. Every request must go
   `renderer → preload → main → Python API`, and each hop can enforce checks.

## Module boundaries

| Module | Path | Responsibility | Rule |
|---|---|---|---|
| UI | `frontend/src/renderer` | Presentation only | Talks only to the preload bridge, never to the OS or backend directly |
| Electron main | `frontend/src/main` | Window/tray lifecycle, Windows autostart, spawns & supervises the Python backend | No business logic — orchestration only |
| AI system | `backend/app/ai` | Reasoning/orchestration, decides *what* should happen. `manager.py` never calls a specific backend's API directly — only `backend.py`'s `AIBackend` Protocol, resolved via `backends.py`'s `get_backend()`. `ollama_backend.py` is the only implementation today; `config.py` holds the user-changeable model choice (Settings, default `llama3.1:8b`). | Never touches the OS directly. Adding another local backend is a new module + one registry entry, no changes to `manager.py`. |
| Voice system | `backend/app/voice` | Speech-to-text / text-to-speech | Engine is swappable independent of AI logic |
| Computer control | `backend/app/control` | The only module allowed to perform OS actions: `actions.py` (open/close/switch a whitelisted app, open Settings) and `files.py` (search/find/create/rename/organize, scoped to the user's own Desktop/Documents/Downloads/Pictures/Music/Videos) | Must request permission from Security before every action; risky actions (closing an app, organizing a folder) additionally require fresh user confirmation each time, enforced by the AI manager. No delete capability anywhere. |
| Memory system | `backend/app/memory` | `store.py` — raw conversation history for the local AI backend's context. `facts.py` — named preferences explicitly taught by the user (e.g. "Remember I use VS Code"), used both for direct recall and to resolve aliases like "my editor". `config.py` — the on/off switch for both. | Owns its own storage; exposes a narrow read/write API. Facts are never used for anything beyond text replies and alias substitution — never a bypass around Security/Control. |
| Automation system | `backend/app/automation` | `routines.py` — CRUD storage for user-created routines (named, ordered lists of steps) plus validation of what a step is allowed to be. | Owns its own storage; steps are restricted to capabilities Control already exposes individually (open/switch/settings/open-folder/check-performance) — never a new capability. Routines are created/edited only via the Automations page, never through chat. Running one always goes through the AI manager's confirmation flow, no exceptions. |
| Action history | `backend/app/history` | `action_log.py` — capped, persisted, append-only log of actions actually executed (open/close app, file ops, routine runs, permission changes), read-only from the outside. | Distinct from Memory: records actions taken, not conversation content. Written only at the point of execution inside AIManager's shared action helpers and PermissionManager.grant/revoke — never at the point of request. |
| Settings | `backend/app/settings` | Single source of truth for user-configurable options, stored on disk | Read by any module; written only through its own API |
| Security & permissions | `backend/app/security` | Defines permission scopes (e.g. `control.mouse`, `control.keyboard`, `fs.read`, `fs.write`), default-deny, explicit user grant | Gatekeeper — Control and Memory must pass through it |

All five JSON-backed stores above (permissions, facts, conversation history,
routines, action history) share one caching discipline: reads are cached in a
module-level dict keyed by resolved file path, not per-instance — several of
these classes are constructed fresh per HTTP request while `AIManager` holds
one long-lived instance of each, and a per-instance cache would let the
long-lived one see a stale value after a different instance's write. Every
write still goes to disk first; the cache only updates after that succeeds.

## Communication contract

Documented in `shared/ipc-contract.md`. Both sides agree on the same message envelope
so the Electron main process and the Python backend never drift out of sync.

## Data flow (implemented — see shared/ipc-contract.md for exact request shapes)

```
mic audio → Voice (transcribe) → AI manager (local Ollama model, or the
  pattern-matched fallback if Ollama isn't running) → if a tool call: Control
  asks Security for permission → granted → Control executes; denied → AI
  tells the user how to enable it → AI logs the turn to Memory → reply →
  Voice (speak it) → UI updates
```

This is a synchronous REST round trip today (record a whole utterance, POST it,
get transcript + reply + audio back), not the streaming shown in the transport
section above — the WebSocket stays a stub until continuous/streaming
transcription is built.

## Autostart

Implemented via Electron's `app.setLoginItemSettings({ openAtLogin: true })` in
`frontend/src/main/autostart.ts`. No registry edits. Toggleable later from Settings.

## Startup, crash recovery, and error handling

`frontend/src/main/backendManager.ts` continuously polls `/health` after
spawning the backend (not a one-time readiness check) and reports
`starting`/`online`/`offline`/`crashed` over IPC — this is what the Sidebar's
status dot and the AI core's "connecting" visual state reflect, replacing an
earlier hardcoded "Backend offline" label. The same poll is the signal for
automatic respawn if the process exits unexpectedly: backoff-capped retries
(1s/2s/4s/8s/16s, max 5), resetting once continuously healthy for 30s, with a
terminal `crashed` state (persistent UI indication + tray balloon) if all
retries are exhausted. A deliberate `stopBackend()` (app quit) never triggers
this — only an unexpected exit does.

Backend startup cost was also cut directly: `speech_recognition` used to be
imported at `app.api.server`'s module top, paid on every boot before
`/health` could even be served, regardless of whether a voice request ever
happened. It's now imported lazily at its actual call site. (JARVIS has
since replaced the Anthropic API with a local Ollama backend entirely — see
the AI system module boundary above — which removes that import cost
altogether for the model connection itself, rather than just deferring it.)

On the error-handling side: a global FastAPI exception handler returns a
clean generic error instead of a raw traceback for anything unhandled
(registered on a separate middleware layer from the one handling
`HTTPException`, so real 400s/404s elsewhere are unaffected), Ollama API
errors are caught in `AIManager` and turned into a graceful reply instead of
a 500, and a React `ErrorBoundary` wraps the whole frontend so a render bug
in one view can't blank the entire app. Settings/Automations/Memory retry
their initial data fetch automatically once the backend status flips back to
`online`, rather than being stuck on a failure placeholder.

## Update system

`electron-updater` is wired in `frontend/src/main/updater.ts` (guarded behind
`app.isPackaged`, `autoDownload` off — the user explicitly triggers a
download from Settings) and configured against a **placeholder** GitHub
repo in `package.json`'s `build.publish`. This must be replaced with the
project's real repo before a check can succeed — until then, "Check for
updates" fails cleanly with a friendly message, which is itself the correctly
verified behavior for an unconfigured release channel, not a bug.

## Current state

Working end to end: the UI shell (including real Memory and Automations
pages, not just placeholders), Windows packaging (installer, tray, startup),
voice (STT/TTS), the AI manager (a local Ollama model with tool use — free,
no API key, no cloud — falling back to plain pattern matching if Ollama isn't
installed or running) with persisted conversation history
*and* taught preferences, and a persisted, Settings-controllable permission
system covering five scopes plus a separate (default-on) memory toggle.
Computer control covers a whitelisted set of apps — open, close (with
mandatory confirmation), switch to, plus opening Windows Settings and a
personal folder in Explorer — and a file assistant scoped to the user's
personal folders — search, find, create, rename, organize (also with
mandatory confirmation). A read-only CPU/RAM/disk check (`psutil`) rounds out
the building blocks automations are made of. Deleting files and changing
system settings are not exposed anywhere. Users can save named routines (e.g.
"Gaming Mode", "Work Mode") from the Automations page as an ordered list of
those same building blocks, then trigger one with a single command or a
button — every run is described step by step and requires explicit
confirmation first, no exceptions, the same mechanism closing an app or
organizing a folder already use.

A hardening pass (security/performance/quality) added: a real confirmation
modal shared by every risky action (replacing chat-text-only confirmation), a
persisted action-history audit log with a Settings card, module-level caching
across all five JSON stores (eliminating a disk read on every single
permission check or memory access), lazy backend imports (faster boot), a
real health-check-driven startup
sequence with automatic crash recovery (backoff-capped respawn) replacing a
fire-and-forget spawn with no readiness check, global error handling on both
sides (clean 500s, a React error boundary, automatic view recovery once the
backend comes back), smoother AI-core state transitions with
`prefers-reduced-motion` support, and `electron-updater` wired end to end
(pointed at a placeholder repo pending real release hosting). A genuine,
previously-existing permission bug was also fixed in the process: organizing
a folder didn't re-check its permission at confirmation time the way closing
an app already did.

Broader control (mouse, keyboard, arbitrary files outside the personal
folders, closing apps or organizing folders as routine steps) is future work,
added the same way. The Conversations sidebar page is still a placeholder,
and the packaged installer doesn't bundle the Python backend (see README's
packaging section).

The Anthropic API has since been removed entirely — JARVIS runs on a local
AI backend instead, so the whole project works for free with no API key, no
account, and no cloud model anywhere. `AIManager` reaches it only through
`app.ai.backend.AIBackend`, a small Protocol (`is_available()`, `chat()`)
resolved via `app.ai.backends.get_backend()` — Ollama
(`backend/app/ai/ollama_backend.py`) is the only implementation today, but
a different local backend can be added later as one new module registered
in `app.ai.backends`, with no changes to `AIManager` itself. Which model
Ollama uses is a Settings-page choice (`app.ai.config`, default
`llama3.1:8b`), read fresh on every turn, so switching models applies
immediately, no restart. The fallback regex/pattern-matched path is
unchanged and still covers every command if the backend isn't reachable —
Settings shows an "Offline" status and "Local AI not connected." in that
case, and JARVIS still opens and answers normally either way.
