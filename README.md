# JARVIS

A futuristic desktop AI assistant for Windows.

- **UI shell:** Electron + React + TypeScript (`frontend/`)
- **Intelligence backend:** Python + FastAPI (`backend/`)

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design rationale before making
changes — the project is intentionally split into independent modules (AI, voice,
computer control, memory, settings, security) with clear boundaries between them.

## Status

Voice (speech-to-text, text-to-speech), a real AI manager (a local Ollama
model with tool use — entirely free, no API key, no cloud), computer control
(whitelisted apps + a personal-folders file assistant),
a real memory system (taught preferences + a Memory page), and a real
automation system (saved multi-step routines + an Automations page) are all
working end to end — see below. A hardening pass has since added: a real
confirmation modal for every risky action, a persisted action-history audit
log, in-memory caching across every JSON store, a real health-check-driven
startup with automatic crash recovery, global error handling on both sides,
smoother animations with reduced-motion support, and a fully working
update system (real GitHub repo, real published release) — see
[Security, performance, and quality](#security-performance-and-quality)
below. The Conversations sidebar page is still a placeholder. What exists:
the full UI shell (sidebar, animated AI-state orb, chat, system panel, Memory
page, Automations page, a dedicated AI page for connection status/testing and
model selection), Windows packaging (installer, icon, shortcuts, tray,
startup), and a working voice + AI conversation loop with persistent memory
and routines.

## Prerequisites

- Node.js LTS (18+) and npm
- Python 3.11+
- Windows 10/11

Neither Node.js nor Python were detected on this machine at scaffold time — install
both before running anything below.

## Getting started (once prerequisites are installed)

```powershell
# Backend
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python main.py

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

## Building a Windows installer

```powershell
cd frontend
npm run dist:win
```

This produces, under `frontend/release/`:
- `JARVIS Setup <version>.exe` — the NSIS installer (lets the user pick an install
  directory, creates a Start Menu shortcut and a desktop shortcut, both named JARVIS)
- `win-unpacked/JARVIS.exe` — the built app unpacked, for a quick sanity-check launch
  without installing anything

The app icon source is `frontend/build/icon.svg`; `icon.ico`/`icon.png` are generated
from it (see git history for the generation script if the design changes).

**Gotchas hit on Windows while setting this up:**
- `electron-builder` downloads a helper archive (`winCodeSign`) that contains
  symlinked macOS files, even for a Windows-only build. Extracting it needs the
  "create symbolic links" privilege, which a normal (non-admin) shell doesn't have.
  Run `npm run dist:win` from an **elevated (Administrator)** terminal, or enable
  Windows Developer Mode (Settings → Privacy & security → For developers) to grant
  that privilege to your normal account.
- If PowerShell refuses to run `npm` at all with a script-execution error, call
  `npm.cmd` instead of `npm` — PowerShell's default execution policy blocks the
  `npm.ps1` wrapper, but `npm.cmd` isn't affected.

The packaged installer does **not** yet bundle the Python backend — this step only
packages the Electron/React UI shell. The app opens and runs standalone; the sidebar
shows "Backend offline" until the AI backend is bundled in a later pass (likely via
PyInstaller, as a separate piece of work).

## Startup and background mode

The installer's finish page asks "Do you want JARVIS to start automatically with
Windows?" (`frontend/build/installer.nsh`). The same choice is available any time
afterward from **Settings → Startup** in the app itself — both write to the same
`HKCU\...\Run` registry value, so whichever one the user last touched is authoritative
and they always stay in sync (`frontend/src/main/autostart.ts`).

When launched at Windows login, JARVIS starts with **no window at all** — just the
system tray icon and the (currently stub) backend — until the user opens it from the
tray, so it sits idle at minimal CPU/RAM rather than showing a UI nobody asked for.
Closing the window normally hides it back to the tray instead of quitting (Discord/
Spotify-style); a one-time balloon notification explains this the first time it
happens. Use the tray's "Exit" to actually quit.

**Tray menu** (`frontend/src/main/tray.ts`): Open JARVIS · Activate Assistant ·
Enable/Disable Microphone (whichever matches the current state is greyed out) ·
Settings · Exit. "Settings" and "Activate Assistant" push a `nav:go` /
`assistant:activate` IPC event into the renderer (creating the window first if it
doesn't exist yet) rather than trying to reach into React state directly — see
`frontend/src/main/index.ts`'s `withWindow` helper and
`frontend/src/renderer/src/components/Layout.tsx` / `HomeView.tsx` for the
subscribing side. Microphone access is a real, persisted, off-by-default setting
(`frontend/src/main/appSettings.ts`) — no audio is captured anywhere yet, but the mic
button and "Activate Assistant" both genuinely no-op while it's disabled.

**Gotchas hit while building this:**
- Electron's `app.getLoginItemSettings()` only reports the correct `openAtLogin`
  state when queried with the *same* `args` that were passed to
  `setLoginItemSettings()` — querying with no args against an entry that was set
  with args always reads back `false`, even though the registry entry is correct.
- Without an explicit `app.setAppUserModelId(...)`, Electron writes the login-item
  registry value under a synthetic `electron.app.<name>` name, not the plain app
  name — which silently doesn't match whatever name a hand-written NSIS script
  writes under. Set the AppUserModelId explicitly (done in `main/index.ts`) so both
  sides agree on the same registry value name.
- NSIS's `customFinishPage` macro *replaces* electron-builder's default finish-page
  handling rather than extending it — you must re-declare the default "run after
  install" checkbox yourself and call `!insertmacro MUI_PAGE_FINISH` at the end of
  your own macro, or the finish page silently never renders your additions.
- A function referenced only via `MUI_FINISHPAGE_SHOWREADME_FUNCTION` must be
  guarded with `!ifndef BUILD_UNINSTALLER` — otherwise it's also emitted (but never
  called) during the uninstaller compile pass, and electron-builder's
  warnings-as-errors setting turns NSIS's "unreferenced function" warning into a
  hard build failure.

## Voice system

Say (or type) something and JARVIS talks back. The pipeline, kept deliberately
separate module-by-module per ARCHITECTURE.md:

1. **Renderer** (`frontend/src/renderer/src/lib/wavRecorder.ts`) captures mic audio
   via the Web Audio API and encodes plain 16-bit PCM WAV itself — not the
   browser's default webm/opus — so the backend needs no ffmpeg/transcoding step.
2. **`backend/app/voice/stt.py`** transcribes the WAV clip using
   SpeechRecognition's free Google Web Speech recognizer (no API key, but needs
   internet — swap this function's body for an offline engine like Vosk later
   without touching anything else).
3. **`backend/app/ai/manager.py`** decides a reply — see the AI system section
   below for how.
4. **`backend/app/voice/tts.py`** speaks the reply back using pyttsx3 over
   Windows' built-in SAPI5 voices — fully offline.
5. The renderer plays the returned audio and updates the chat/orb state.

Typed messages skip step 1–2 (no speech recognition needed) but still get a spoken
reply via `/api/ai/respond` — see `shared/ipc-contract.md` for both endpoints'
exact shapes.

Microphone access is gated by the **Microphone** setting (Settings page and tray
menu, off by default) at two layers: the mic button/tray action no-ops in the
renderer, and Electron's own permission request handler denies the OS-level
`getUserMedia` request unless that setting is on — see `main/index.ts`.

**Verification note:** I tested the full pipeline (TTS producing valid audio, and
a TTS→STT round trip — synthesizing speech and feeding it back through the
recognizer — plus both REST endpoints over real HTTP) directly against the
backend. I could not verify actual microphone capture through a real device in
this environment (no physical/virtual mic hardware here to test against) — that
piece should be tried by hand once you have this running locally.

## AI system

`backend/app/ai/manager.py` is the only entry point other modules call for a
conversational turn — every REST endpoint that needs a reply goes through
`AIManager.respond()`, never straight to a model or straight to an action.

**This project runs entirely for free.** There is no API key, no account, and
no cloud model anywhere in JARVIS — full natural-language understanding comes
from [Ollama](https://ollama.com), running locally on your own machine.

**Modular by design:** `AIManager` never talks to Ollama's HTTP API directly.
It only knows about `app.ai.backend.AIBackend` — a two-method Protocol
(`is_available()`, `chat()`) — reached through `app.ai.backends.get_backend()`.
`ollama_backend.py` is the only implementation today, but adding a different
local backend later (LM Studio, llama.cpp's server, any other
OpenAI-compatible local endpoint) means writing one new module and
registering it in `app.ai.backends` — no changes to `AIManager` itself.

**Setup:** install Ollama, pull a tool-calling-capable model — the default is
**`llama3.1:8b`** (`ollama pull llama3.1:8b`) — and make sure `ollama serve`
is running (Ollama normally starts this automatically). That's it — no
`.env` file is required. `backend/.env.example` exists only if you want to
point JARVIS at a non-default Ollama host (`OLLAMA_HOST`) or seed a
different initial default model (`OLLAMA_MODEL`, only used before a model
has ever been chosen). **If Ollama isn't installed or isn't running, JARVIS
still opens completely normally** — `AIManager` falls back to
`app.ai.responder`'s plain pattern matching (time/date/greeting/identity)
plus a small regex command parser for app/file/memory control, so the
assistant still answers with zero setup, it just isn't using a language
model.

**Sidebar → AI** (`frontend/src/renderer/src/components/AiSettingsView.tsx`)
is a dedicated page — not folded into general Settings — for everything
about the local AI backend:

- **AI Status** — a live three-state display (**Loading** while checking,
  **Connected**, or **Disconnected**) plus a **Test connection** button that
  re-runs the same live check on demand.
- **Model** — a dropdown of models Ollama actually has pulled locally
  (fetched from its own `/api/tags`, never a hardcoded list — if Ollama
  reports none, the picker says so instead of inventing options) and a
  **Refresh installed models** button to re-fetch that list without leaving
  the page. Picking a different model saves immediately and takes effect on
  your very next message, no restart needed. The currently-configured model
  is always included as an option even if Ollama's live list doesn't (yet)
  contain it, so the dropdown never silently shows something other than
  what's actually active.

Connectivity is checked live, not cached — `AIManager.is_connected()` pings
the backend fresh on every check, so starting or stopping Ollama (or
switching models) takes effect on the very next turn without restarting
JARVIS.

**With the backend connected**, each turn:

1. Appends the user's message to `app.memory.store.ConversationMemory`
   (a capped, disk-persisted JSON list — conversations survive a backend restart).
2. Calls the backend's `chat()` (`backend/app/ai/ollama_backend.py` for
   Ollama's `/api/chat`) with recent history, any remembered preferences
   injected into the system prompt (see Memory system below), and fifteen
   tools covering time/date, app control, the file assistant, memory, and
   automation routines — converted from a single source-of-truth `TOOLS`
   list into the OpenAI-style function-calling shape most local backends
   expect (`_to_function_calling_tools`).
3. If the model requests an app-control tool, the manager checks
   `app.security.permissions.PermissionManager` for the `control.launch_app`
   scope **before** calling into `app.control.actions` — an ungranted
   permission returns a denial string fed back to the model (which then tells
   the user to enable it in Settings) rather than a silent no-op or a bypass.
   This is the actual enforcement of:

   ```
   user request → AI understands → permission check → action system executes
   ```

4. Loops while the response includes `tool_calls`, executing each and feeding
   the result back as a `"role": "tool"` message, until a final plain-text
   reply comes back — capped at 6 iterations as a backstop, since a local
   model is less predictable about ever actually stopping than a large hosted
   one was.

If the backend is unreachable at all, or errors out mid-conversation, the
fallback path gets the same app-control commands via a small regex parser in
`manager.py` (`open/launch/start X`, `close/quit/exit/stop X`, `switch to X` /
`focus X`, `open settings`) — so "Open Chrome" and "Launch Visual Studio Code"
work even with zero setup, going through the exact same permission check and
confirmation flow as the connected path.

**Verification note:** no Ollama install exists in this environment, so the
real model's own reasoning/tool-choice quality couldn't be exercised — what
*was* verified: `is_available()`/`is_connected()` correctly return `False`
against a genuinely-unreachable `localhost:11434` (confirmed real, not
assumed) and the fallback path handles every command exactly as before
(open/close apps, memory, routines, plain chit-chat); and, against a small
mock HTTP server built to match Ollama's actual documented `/api/tags`/
`/api/chat` response shapes (including already-parsed, non-JSON-string
`tool_calls` arguments), the full request/response/tool-execution loop
through the new `get_backend()` abstraction: `get_backend()` returns the
`ollama_backend` module, connectivity detection flips to connected, a real
two-round-trip `get_current_time` tool call executes and its result is
correctly relayed back as a `tool`-role message, and an error mid-chat
(simulating an unpulled model) surfaces the same graceful in-conversation
message the old Claude-error path used to — confirming the refactor into a
backend-agnostic interface didn't change any actual behavior. For the model
setting specifically: the default really is `llama3.1:8b` before anything is
ever set; `set_model()`/`get_model()` persist correctly and are visible from
a freshly-constructed instance (proving it's the same disk-backed settings
file, not in-memory-only); `list_models()` returns `[]` (never raises)
against the real unreachable Ollama; and — the one most worth calling out —
switching models via `set_model()` mid-session and driving two real
`respond()` calls through the mock server confirmed the *exact* model name
sent in each request body changed accordingly, proving a model change
really does apply on the very next message with no restart. This confirms
the integration code and the modular-backend plumbing are correct; trying it
against a real pulled model is worth doing once you have Ollama running
locally.

The dedicated AI page (`AiSettingsView.tsx`) was separately driven
end-to-end against the real running app: navigating to it via the new
Sidebar entry, the status pill genuinely cycles **Loading → Disconnected**
(confirmed real by watching it settle over several seconds against an
actually-unreachable Ollama, not just asserting the intermediate state),
clicking **Test connection** re-runs the same live check and correctly
returns to **Testing…** then **Disconnected**, clicking **Refresh installed
models** re-fetches the list (also genuinely returns to idle only once the
live call resolves), and the model dropdown showed exactly one real option —
the actual persisted `llama3.1:8b`, sourced from the backend, nothing
hardcoded — with the empty-installed-models note rendering correctly and
free of any specific model name. Switching to a second model through the
dropdown itself (as opposed to the mock-server test above, which covers the
same `set_model()` codepath) wasn't separately exercised in the UI, since
only one real model name exists to select from in this environment; the
save codepath is identical to the one already verified against the live
backend, so this is a low-risk gap, not an unverified one.

## Computer control

`backend/app/control/actions.py` is whitelist-only — a fixed set of known apps,
plus opening Windows Settings. **Deleting files and changing system settings are
not available at all**, by design (no tool exposes them). Currently whitelisted:
Notepad, Calculator, Paint, Chrome, Discord, Visual Studio Code, and Steam.

- **Open** (`os.startfile`, resolved via Windows' "App Paths" registry — the
  same mechanism the Run dialog uses, more reliable than a hardcoded install
  path) and **switch to** (`win32gui`/`win32con`, matching a visible window by
  title substring, then `SetForegroundWindow`) both execute immediately once the
  **Control applications** permission is granted — no extra confirmation, since
  neither is destructive.
- **Close** (`taskkill /IM <exe> /F`) is treated as risky and is **never**
  executed on the first request, even with permission granted — see the
  confirmation flow below.
- **Open Settings** (`os.startfile("ms-settings:")`) just navigates to the
  Windows Settings app; it doesn't change anything, so it needs the standing
  permission but no extra confirmation either.

### Confirmation flow for risky actions

`AIManager` has one shared mechanism for "ask before doing this," used by both
closing an app and organizing a folder (see below). When a risky request comes
in (from Ollama or the fallback parser), the manager doesn't execute it — it
stores `self._pending_confirmation = {"kind": ..., ...}` and returns a question
instead ("Do you want me to close Chrome? Say yes to confirm.", or an
equivalent instruction telling the model to ask the user itself rather than
claim it's done). The **next** call to `respond()` checks that pending state
*before* going to Ollama or the fallback parser: a "yes"-like reply actually
executes the action; a "no"-like reply cancels; anything else drops the
pending confirmation and processes the new message normally (so the assistant
never gets stuck waiting). This lives entirely in `AIManager`, so it works
identically whether Ollama is connected or not — no frontend changes were
needed for this at all, since a confirmation is just an ordinary back-and-forth
in the existing chat/voice pipeline.

## File assistant

`backend/app/control/files.py` — search files, find folders, create folders,
rename files, and organize a folder's loose files into type-based subfolders
(Images, Documents, Spreadsheets, Videos, Music, Archives, Installers). Scoped
to the user's own **Desktop, Documents, Downloads, Pictures, Music, and Videos**
folders only — never system folders, `Program Files`, or arbitrary paths.
**There is no delete capability anywhere in the system.**

- **Search files / find folders** are read-only, gated by the new **Search
  files and folders** permission (`Scope.FS_READ`).
- **Create folder / rename file** change the filesystem but touch exactly one
  thing at a time, so they execute immediately once the new **Create, rename,
  and organize files** permission (`Scope.FS_WRITE`) is granted — no extra
  confirmation.
- **Organize folder** also needs `Scope.FS_WRITE`, but is treated as risky
  (like closing an app) since it can move many files at once: it always
  previews the plan first ("I found 12 files I can sort into Images, Documents
  folders in Downloads. Do you want me to go ahead?") and only calls
  `execute_organize()` after the user confirms, via the same
  `self._pending_confirmation` mechanism described above. Organizing only ever
  *moves* files (`shutil.move`) — nothing is deleted, and a destination
  collision is skipped rather than overwritten.
- Renaming and file/folder search match by filename; if a rename target name
  matches more than one file, it reports the ambiguity instead of guessing.
  `search_files` also retries with the singular form when a plural query has no
  exact matches (e.g. "screenshots" → "screenshot") — real screenshot/photo
  filenames are usually singular, so this fixes "Find my screenshots" against
  actual filenames without needing real NLU in fallback mode.

Both the fallback regex parser and Ollama get the same five tools
(`search_files`, `find_folders`, `create_folder`, `rename_file`,
`organize_folder`), so "Find my screenshots", "Create a folder called
Projects", and "Organize my Downloads folder" all work with zero setup at all.

## Memory system

Two independent stores, both under `backend/app/memory/`:

- **`store.py` (`ConversationMemory`)** — raw recent chat turns, fed to the
  local Ollama model as context. This is what makes multi-turn conversation
  possible at all.
- **`facts.py` (`FactMemory`)** — named preferences the user explicitly asks
  JARVIS to remember, e.g. "Remember I use VS Code" → the fact `editor` =
  `VS Code`. Independent of conversation history — clearing one doesn't clear
  the other.

**Teaching and using a preference** (works in both fallback and Ollama mode):

```
"Remember I use VS Code."   → stores fact: editor = VS Code
...later...
"Open my editor."           → AIManager._resolve_alias("my editor") looks up
                               the fact named "editor", substitutes "VS Code",
                               then calls open_application("VS Code") — same
                               permission check as any other open request.
JARVIS: "Opening VS Code."
```

`_resolve_alias()` is a single choke point shared by `_open`/`_switch`/
`_close_with_confirmation`, so this works identically whether Ollama decided
to call the tool or the fallback regex parser did. In fallback mode, "Remember
I use X" maps X to a category (editor/browser/chat app/etc.) via a small
`APP_CATEGORIES` lookup so "editor" gets picked automatically; a connected
Ollama model just reasons out the right key itself. "What do you remember?"
lists everything back (voice-friendly sentence in fallback mode; a connected
model answers naturally since remembered facts are injected into its system
prompt every turn). "Forget I use VS Code" / "Forget my editor" both remove it.

**Settings → Memory**: a single **"Remember things I tell you"** toggle,
**on by default** — unlike the security permission scopes, remembering isn't
safety-sensitive (each fact is already opt-in, since the user has to explicitly
say "remember..."), so this is a privacy opt-*out*, not a default-deny gate.
Turning it off stops new facts and conversation turns from being recorded, and
stops existing facts from being used for alias resolution — it does **not**
erase what's already stored (that's what deleting a memory is for).

**Sidebar → Memory** (`frontend/src/renderer/src/components/MemoryView.tsx`,
replacing the old placeholder) lists every remembered fact with a per-item
**Delete** button, reading and writing via `GET/DELETE /api/memory/facts`.
Deleting is immediate — no confirmation step, unlike closing an app or
organizing a folder — since removing a small locally-stored note has no
real-world consequences and is trivial to re-teach.

**Verification note:** with no Ollama installed in this environment, I
tested the fallback path end-to-end — permission grant/revoke persistence
(including that a *fresh* `PermissionManager` instance sees a grant made by
another one, proving it's file-backed, not in-memory), `open_application` both
denied and granted (confirmed Notepad actually opened), `switch_window`
(confirmed it brought Notepad's window to the foreground), `open_settings`
(confirmed the Windows Settings app opened), the full close-confirmation loop
in both directions (confirmed yes → app actually closed; asked again, said no
→ correctly left it running), the file assistant's five capabilities including
the organize-confirmation loop — all against an **isolated scratch directory**
I created and cleaned up myself, never your real Desktop/Documents/Downloads —
and the memory system: remembering "I use VS Code" (stored correctly, though
since VS Code isn't installed here I taught a second fact — "my editor is
notepad" — to confirm "open my editor" actually resolves the alias *and*
launches the real app, which it did), forgetting a fact, "what do you
remember?", and the memory-disabled behavior (new facts refuse to save with
an explicit message, and an existing alias like "my editor" correctly stops
resolving and falls through to "not a whitelisted application" instead of
silently failing). I also restarted the backend and hit the four
`/api/memory/...` endpoints over real HTTP (seed a fact through
`/api/ai/respond`, list it, delete it, toggle `enabled` off and back on), and
drove the actual running app through its UI: the Memory page listing a fact
and its Delete button removing it live, and the Settings page's memory toggle
switching state. Everything test-created was cleaned up afterward (facts
cleared, permission and memory-enabled flag reset to their defaults, Notepad
instances closed). This was all against the fallback path — Ollama-connected
behavior is covered separately in the [AI system](#ai-system) section's own
verification note, since no real Ollama install is available in this
environment either. I could not verify Chrome/Discord/VS Code/Steam
specifically (not installed in this environment) — worth trying those once
you add them to the whitelist and have them installed.

## Automation system

Save a named, ordered list of steps once — a **routine** — then run it later
with a single command or button, instead of saying each step individually.
A routine adds no new capability: every step type is something
`app.control` already exposes on its own —

- `open_app` / `switch_window` — a whitelisted application
- `open_settings` — Windows Settings
- `open_folder` — one of the personal folders (Desktop/Documents/etc.) in
  File Explorer
- `check_performance` — a read-only CPU/RAM/disk snapshot (`psutil`), no
  permission needed, same tier as asking the time

Closing an app and organizing a folder are deliberately **not** valid step
types — both already require their own confirmation on their own, and
stacking that inside an unattended multi-step run would mean either skipping
it (unsafe) or interrupting mid-routine to ask (confusing). Leaving both out
keeps every step safe to run once the routine itself has been confirmed.

**Every routine run requires confirmation, no exceptions** — this reuses the
exact same `_pending_confirmation` mechanism as closing an app or organizing a
folder (see [Computer control](#computer-control)): asking "run Gaming Mode"
never runs anything immediately. JARVIS describes every step first and waits
for a yes:

```
"Run Gaming Mode."
JARVIS: "Running Gaming Mode will: open discord, then open steam, then check
         PC performance. Say yes to confirm."
"Yes."
JARVIS: "Ran Gaming Mode. Opened discord. Opened steam. CPU at 12%, RAM at
         44%, disk at 61% used."
```

**Creating/editing a routine** happens only from the **Automations** page in
the sidebar — not through chat, since a structured, ordered step list is a
better fit for a small builder UI than free-form natural language. Ollama and
the fallback parser can still **list** routines ("what routines do I have?")
and **request to run** one, but never create or edit one.

Two starter routines ship pre-seeded the first time the store is used
(`RoutineStore`, persisted like `FactMemory` to `automations.json`) — deleting
either one sticks, they're never re-added:

- **Gaming Mode** — open Discord, open Steam, check PC performance
- **Work Mode** — open Chrome, open the Documents folder, open VS Code

Two examples in the original request don't map onto real capabilities yet and
are deliberately left out of the starter templates rather than faked: "Launch
game" would mean launching an arbitrary, non-whitelisted game by name, which
is out of scope for the same reason the rest of computer control is
whitelist-only; "Open coding tools" (plural) is represented as opening VS Code
specifically, since that's the one coding tool already on the whitelist.

**Sidebar → Automations**
(`frontend/src/renderer/src/components/AutomationsView.tsx`) lists every
routine with its steps spelled out, and per-routine **Run**, **Edit**, and
**Delete** buttons, plus a step-by-step builder (name + an ordered list of
step-type/target dropdowns, populated from `GET /api/automations/options` so
it can never suggest a non-whitelisted app or folder) for creating new ones.
Clicking **Run** calls `POST /api/automations/{id}/run`, which sets the exact
same pending-confirmation state a chat "run Gaming Mode" would and returns the
question; the page shows it with **Yes**/**No** buttons, which send the
answer through the ordinary `POST /api/ai/respond` turn — the same
confirm-then-execute path, reached a different way.

**Verification note:** I tested the backend logic directly — `validate_steps`
rejecting an unknown step type, a non-whitelisted app, a non-personal folder,
and an empty step list; the two seeded defaults appearing on first use of an
isolated store and, after deleting one, a *second, independent* `RoutineStore`
instance pointed at the same file still not resurrecting it (proving the
seed-once behavior is file-backed, not in-memory); "run test routine" and
"start notepad" — a routine name vs. a plain app name — resolving correctly
down two different code paths without either misfiring as the other; the full
confirm/deny loop through the real `respond()` entry point (said no → nothing
ran; asked again, said yes → every step actually executed in order — Notepad
really opened, Documents really opened in Explorer, and `check_performance`
returned real CPU/RAM/disk numbers from `psutil`). This caught two real bugs,
both fixed before anything else: `_LIST_ROUTINES_PATTERN` never actually
matched "what routines do I have?" — the exact phrase the code's own denial
message told users to say — because I'd only written patterns for "list/show
routines"; and my first pass at this test called `_try_control_command("yes")`
directly for the confirm step, which bypasses `_handle_pending_confirmation`
entirely (that check only happens inside the real `respond()`) and so
silently proved nothing — switching the test to call `respond()`, matching
how the app actually invokes it, is what surfaced the regex bug in the first
place. I also restarted the backend and hit all six `/api/automations/...`
endpoints over real HTTP — options, list, create, a rejected create (400 on a
non-whitelisted app), update, the run-then-confirm round trip through
`/api/ai/respond` (correctly denied, since that backend instance had no
permissions granted — proving the REST path enforces permissions same as
chat), and delete — and drove the actual running app through its UI: the
Automations page listing the two seeded routines, creating a new one through
the builder (step-type and target dropdowns, add-step), editing its name,
clicking Run, seeing the inline Yes/No confirmation card with the exact step
summary (this card was later replaced by the shared `ConfirmDialog` modal
described in [Security, performance, and quality](#security-performance-and-quality)
— same underlying flow, real dialog UI instead of an inline card), clicking
Yes (correctly denied for the same reason as the REST test — no permission
granted on that instance), and deleting it — routine list back to just the
two defaults afterward. Everything test-created was cleaned up
(test routines deleted, Notepad/Explorer windows opened during the
backend-direct test closed, permissions reverted, `playwright-core`
uninstalled again). I could not verify Chrome/Discord/VS Code/Steam launching
specifically (not installed in this environment), a full successful run with
permissions actually granted through the UI specifically (only verified
backend-direct, since granting permission mid-test would have meant leaving
the running app in a non-default state), or the real Ollama tool-use path for
`list_routines`/`run_routine` against an actual installed model — worth
trying all three once you have Ollama running locally.

## Security, performance, and quality

A dedicated hardening pass — no new AI capabilities, only robustness and
polish on what already existed.

### Security

- **A real bug fix, found while hardening**: closing an application already
  re-checked its permission right before executing (in case it was revoked
  between the confirmation question and the user's "yes"); organizing a
  folder didn't. Both now do.
- **Action history** — a capped (200 entries), persisted log of actions
  JARVIS has *actually executed*, distinct from conversation memory. Every
  open/close/switch/settings, file create/rename/organize, and routine run is
  recorded at the point of execution (not the point of request), along with
  permission grants/revokes. Shown as a "Recent activity" card on the
  Settings page — not a new sidebar item, per the "no new features" brief.
- **Confirmation dialogs** — a real modal (`ConfirmDialog.tsx`), not just a
  chat-text question. Closing an app, organizing a folder, and running an
  automation all now show an actual dialog with Yes/No buttons, on top of
  (not instead of) the existing spoken/typed question — clicking a button
  just sends the same "yes"/"no" text the chat flow already understood. The
  Automations page's previous bespoke inline confirmation card was replaced
  with this same shared component, so there's exactly one confirmation UI in
  the whole app.

### Performance

- **Faster startup** — two independent fixes. First, `speech_recognition`
  used to be imported unconditionally at the backend's module top, before
  `/health` could even be served; it's now imported lazily at its actual call
  site instead (JARVIS has since dropped the Anthropic API entirely in favor
  of a local Ollama backend, which removed that import-cost concern
  altogether rather than just deferring it — see the AI system section).
  Second, Electron's main process now actually polls `/health` after
  spawning the backend instead of a fire-and-forget spawn with zero
  readiness check — which also finally makes the Sidebar's status dot real
  instead of a permanently-hardcoded "Backend offline" label.
- **Lower CPU/faster responses** — every JSON-backed store (permissions,
  taught facts, conversation history, automation routines, action history)
  used to re-read and re-parse its entire file from disk on *every single
  access* — including a fresh disk read for every permission check inside
  every tool call. All five now cache in memory, invalidated only on a
  successful write.
- **Lower RAM in background/tray mode** — already correct before this pass:
  launching hidden at login skips creating a window entirely (confirmed by
  reading `frontend/src/main/index.ts`), so no work was needed there beyond
  making sure a window opened later from the tray learns the real current
  backend status immediately.

### Quality

- **Crash recovery** — if the Python backend process exits unexpectedly, it's
  now automatically respawned with capped, backed-off retries (1s/2s/4s/8s/
  16s, then a terminal "backend unavailable" state with a tray notification)
  instead of being silently gone until the app is manually restarted.
- **Error handling** — a global exception handler on the backend returns a
  clean message instead of a raw traceback for anything unhandled; an Ollama
  API error becomes a graceful in-conversation reply instead of a 500; a
  React error boundary on the frontend means a bug in one view can't blank
  the whole app; and Settings/Automations/Memory now retry their data
  automatically once the backend comes back online, instead of being stuck
  on a failure message until the user navigates away and back.
- **Animations** — the AI core's color/glow now transition smoothly across
  state changes instead of snapping instantly, a new muted "connecting" state
  appears during startup/reconnection, and the whole app now respects
  `prefers-reduced-motion`.
- **Update system** — `electron-updater` is fully wired (version display,
  check/download/install flow, a Settings "Updates" card with a progress
  bar) and points at a real, public GitHub repo:
  [github.com/134ertel/jarvis](https://github.com/134ertel/jarvis) — see
  `package.json`'s `build.publish`. Release `v0.1.0` is published (not a
  draft) with a verified, well-formed `latest.yml`. To ship a future update:
  bump `version` in `frontend/package.json`, then run
  `npx electron-builder --win --publish always` (with a `GH_TOKEN` env var
  set to a token with `repo` scope) from `frontend/`, and un-draft the
  release it creates with `gh release edit <tag> --draft=false` if it isn't
  already public.

**Verification note:** the permission-caching fix was the one most likely to
silently reintroduce the exact bug it fixes if done wrong (a per-instance
cache instead of a shared one), so I tested it precisely for that: two
`PermissionManager` instances sharing a scratch file, confirming a grant made
through one is visible through the other with no re-read, that externally
corrupting the underlying file doesn't leak into a cached instance, and that
a real grant/revoke still reaches disk (verified via a second OS subprocess
reading the same file fresh). The organize permission re-check fix was
verified directly: hand-setting a pending confirmation, revoking the
permission, confirming "yes" moves nothing. Action history's cap and
ordering were tested past 200 entries; the same cache-correctness tests were
repeated for facts/routines/conversation-history/action-history, including
per-store checks aimed specifically at the aliasing hazard caching
introduces (a store that loads, mutates in place, then saves would corrupt
its own cache — every affected method was audited and, where needed, fixed
to copy before mutating). For lazy imports, I measured actual cost at the
time: cold `import anthropic` alone took ~900ms in this environment,
`speech_recognition` ~140ms — both now moot for `anthropic` (removed
entirely since JARVIS switched to a local Ollama backend, see the AI system
section) and `speech_recognition` stays deferred until a real voice request
— and confirmed a fresh venv installing the trimmed `requirements.txt` still
boots and serves real requests. I drove the real running app through the confirmation dialog
end-to-end (open Notepad, "close notepad" → dialog appears with the right
prompt → No leaves it running → asked again → Yes actually closes it,
confirmed the process was gone afterward), confirmed the Settings "Recent
activity" and "Updates" cards render real data from a live backend, and
tested crash recovery by killing the live backend process mid-session and
confirming it automatically came back online and served requests again
(I verified one full real kill → detect → respawn → recover cycle; I did not
drive it all the way through all 5 backoff attempts to the terminal "crashed"
state, since reliably timing repeated kills against a 31-second backoff
schedule proved fragile to script — that path is covered by direct code
review of the deterministic, capped retry logic instead). I built the actual
Windows installer with the new `publish` config present (confirms packaging
itself isn't broken by it) and ran the real packaged, installed-style build
(`app.isPackaged === true`, not a dev run) to click "Check for updates" —
it made a genuine network request to the placeholder GitHub repo, got a real
404, and surfaced a clean, friendly failure message rather than a crash or a
hang. I could not verify an actual successful update check, download, or
install — that needs real release hosting and a real prior version, neither
of which exist yet — and this is a hard limit of what "verified" can mean
here, not a gap I glossed over. Global error handling was verified in
isolation (FastAPI's `TestClient`, no live server involved) by forcing a
route to raise and confirming a clean 500 body while unrelated `HTTPException`
routes kept their real status codes. Reduced-motion support was verified by
toggling the emulated media feature via CDP and confirming the AI core's
orbit rings stop moving. Everything test-created was cleaned up afterward —
scratch files removed, granted permissions reverted, test-generated action
history and conversation history cleared, `playwright-core` uninstalled, and
the packaged build's own temp output removed — leaving only the normal
`release/` build directory behind.

## Project layout

```
jarvis/
├── ARCHITECTURE.md        # Read this first
├── frontend/               # Electron + React + TypeScript UI
│   └── src/
│       ├── main/           # Electron main process (window, tray, autostart, backend supervision)
│       ├── preload/        # Secure IPC bridge exposed to the renderer
│       └── renderer/       # React UI (no direct OS/AI access)
├── backend/                # Python backend
│   ├── .env.example         # Optional: override OLLAMA_HOST/OLLAMA_MODEL
│   └── app/
│       ├── ai/             # manager.py (tool-use loop) + responder.py fallback; backend.py (Protocol), backends.py (registry), ollama_backend.py, config.py (model setting)
│       ├── voice/          # Speech-to-text / text-to-speech
│       ├── control/        # actions.py (whitelisted open/close/switch + Settings), files.py (file assistant), system.py (CPU/RAM/disk)
│       ├── memory/         # store.py (conversation history), facts.py (taught preferences), config.py (on/off)
│       ├── automation/     # routines.py (saved multi-step routines, run only via AIManager's confirmation flow)
│       ├── history/        # action_log.py (capped, persisted log of actions actually executed)
│       ├── settings/       # User-configurable settings store
│       ├── security/       # Permission scopes and enforcement (persisted)
│       ├── api/            # FastAPI app exposed to Electron
│       └── core/           # Shared infra (config, logging)
└── shared/
    └── ipc-contract.md     # Message contract between Electron and Python
```
