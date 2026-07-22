"""AI manager — the only entry point other modules call for a conversational turn.

Understands natural language via a local AI backend (falling back to
responder.py's simple pattern matching, plus a small regex command parser for
app/file/memory control, if that backend isn't reachable), remembers
conversation history and explicitly-taught preferences via app.memory, and
can request actions — but never executes them itself. Every action request
goes:

    user text -> AIManager (the backend decides, or the fallback parser) ->
    app.security (permission check) -> app.control (executes) -> reply

This project runs entirely for free and fully locally — no API key, no
account, no cloud model. AIManager never talks to a specific backend's HTTP
API directly, only through app.ai.backend.AIBackend, reached via
app.ai.backends.get_backend() — see that module for how another backend
could be added later. Ollama (app.ai.ollama_backend) is the only one
implemented today, with its model chosen via app.ai.config (user-changeable
from Settings, default "llama3.1:8b"). If the current backend isn't
reachable, JARVIS still opens normally and simply runs in fallback mode
(Settings shows "Local AI not connected." / "Offline").

Closing an application and organizing a folder are both treated as risky: even
with the standing permission granted, AIManager never executes them
immediately — it first asks the user to confirm (via
self._pending_confirmation, checked at the top of the *next* respond() call)
and only executes once they say yes, identically whether the backend is
connected or not.

Remembering/forgetting a preference (app.memory.facts.FactMemory) is not
treated as risky — it's simple, reversible, local text storage the user always
asks for explicitly by saying "remember ..." — so it executes immediately, in
both modes. Remembered facts double as alias resolution: "open my editor"
resolves "editor" to whatever app was last remembered under that name before
calling app.control, in _open()/_switch()/_close_with_confirmation() — a
single choke point shared by both the backend and fallback dispatch paths.

Running a saved automation routine (app.automation.routines.RoutineStore) is
always treated as risky, no exceptions — every routine run goes through the
same self._pending_confirmation mechanism as closing an app or organizing a
folder, listing exactly what it will do before anything runs. Routines are
created/edited from the Automations page in the UI, not through chat; the
backend and the fallback parser can only list and run them.
"""

import json
import re
from datetime import datetime
from pathlib import Path

from app.ai import responder
from app.ai.backend import AIBackendError
from app.ai.backends import get_backend
from app.automation.routines import RoutineStore
from app.control import actions, files, system
from app.history.action_log import ActionLog
from app.memory import config as memory_config
from app.memory.facts import FactMemory
from app.memory.store import ConversationMemory
from app.security.permissions import PermissionManager, Scope

SYSTEM_PROMPT = (
    "You are JARVIS, a personal desktop assistant running locally on the user's "
    "own Windows PC. Keep replies short and conversational — this is spoken "
    "aloud, not read as text on a screen. You can open, close, or switch to "
    "any application actually installed on this PC (not just a fixed list — "
    "say the name naturally, e.g. 'Spotify' or 'Steam', and it'll be looked "
    "up), open common websites like YouTube, Netflix, Gmail, or Amazon (or "
    "any web address the user names), and open Windows Settings, if the user "
    "has granted the 'Control applications' permission in Settings. You can "
    "also search for files, find folders, create folders, rename files, and "
    "organize a folder's loose files into subfolders by type — anywhere on "
    "the user's PC, not just their personal folders. Leave the location "
    "unsaid to search Desktop/Documents/Downloads/Pictures/Music/Videos (the "
    "fast default); name a drive letter or a full path to reach elsewhere, "
    "including system or program folders. Searching and finding need the "
    "'Search files' permission, the rest need 'Manage files'. If a tool call "
    "comes back denied, tell the user it's "
    "blocked and that they can allow it from Settings — don't retry. "
    "Closing an application and organizing a folder are different: neither is "
    "ever carried out immediately, even with permission granted. If a result "
    "starts with 'CONFIRMATION_REQUIRED', that means nothing has happened yet "
    "— ask the user to confirm out loud before anything closes or moves, and "
    "do not claim it's done. You don't need to call the tool again for their "
    "answer; that's handled separately. You can remember short preferences the "
    "user explicitly asks you to remember (e.g. 'Remember I use VS Code') via "
    "remember_fact, and forget them via forget_fact — only do this when they "
    "actually ask you to remember or forget something, don't do it on your "
    "own. Any preferences already remembered are listed below if there are "
    "any; use them to resolve references like 'my editor' to the actual app "
    "name when opening, closing, or switching to it. The user can also save "
    "automation routines — named sequences of steps like 'Gaming Mode' — from "
    "the Automations page; you can list them with list_routines and run one "
    "with run_routine, but you can't create or edit one yourself, that only "
    "happens in the UI. Running a routine never happens on the first call, "
    "exactly like closing an app or organizing a folder — always wait for the "
    "user's confirmation. If asked to do something you have no tool for — "
    "like deleting files or changing a system setting — say plainly that you "
    "can't do that yet, don't pretend you did."
)

TOOLS = [
    {
        "name": "get_current_time",
        "description": "Get the current local time on the user's computer.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_current_date",
        "description": "Get the current local date on the user's computer.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "open_application",
        "description": (
            "Open a desktop application by name — any application actually "
            "installed on this PC, not a fixed list — or a common website "
            "(e.g. 'YouTube', 'Netflix', 'Gmail') or web address, opened in "
            "the default browser. Requires the 'Control applications' "
            "permission in Settings — if it isn't granted, this returns a "
            "denial, not an error; tell the user how to enable it rather "
            "than retrying. If the name doesn't match anything installed or "
            "a known site, this returns a not-found message — don't claim "
            "it opened."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Which application or website to open, e.g. 'notepad', 'spotify', 'youtube'.",
                }
            },
            "required": ["name"],
        },
    },
    {
        "name": "close_application",
        "description": (
            "Request to close an already-open application (any installed "
            "application, not a fixed list). This never closes anything on "
            "the first call — it always asks the user to confirm first. If "
            "the result starts with 'CONFIRMATION_REQUIRED', relay that "
            "question to the user and wait for their answer; do not call "
            "this tool again for the same request."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Which application to close.",
                }
            },
            "required": ["name"],
        },
    },
    {
        "name": "switch_window",
        "description": "Bring an already-open application's window to the foreground.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Which application to switch to.",
                }
            },
            "required": ["name"],
        },
    },
    {
        "name": "open_settings",
        "description": (
            "Open the Windows Settings app. Read-only navigation — this does "
            "not change any setting."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "search_files",
        "description": (
            "Search for files by name (substring match) anywhere on the "
            "user's PC. Read-only. Omit 'root' to search the personal "
            "folders (fast, the common case); pass a personal-folder name, a "
            "drive letter (e.g. 'D'), or a full path to search elsewhere, "
            "including system/program folders."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Text to search for in file names."},
                "root": {
                    "type": "string",
                    "description": (
                        "Where to search: omit for the personal folders, or give a "
                        "personal-folder name, drive letter, or full path."
                    ),
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "find_folders",
        "description": (
            "Search for folders by name anywhere on the user's PC. "
            "Read-only. Same 'root' rules as search_files."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Text to search for in folder names."},
                "root": {"type": "string", "description": "Personal-folder name, drive letter, or full path."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "create_folder",
        "description": "Create a new folder anywhere on the user's PC.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Name of the new folder."},
                "parent": {
                    "type": "string",
                    "description": (
                        "Where to create it: a personal-folder name, drive letter, or "
                        "full path. Defaults to Documents if not said."
                    ),
                },
            },
            "required": ["name"],
        },
    },
    {
        "name": "rename_file",
        "description": (
            "Rename a file the user already has, anywhere on their PC. If "
            "more than one file matches old_name, this returns an "
            "ambiguous-match message instead of guessing which one."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "old_name": {"type": "string"},
                "new_name": {"type": "string"},
                "root": {"type": "string", "description": "Personal-folder name, drive letter, or full path."},
            },
            "required": ["old_name", "new_name"],
        },
    },
    {
        "name": "organize_folder",
        "description": (
            "Sort loose files in a folder into subfolders by type (Images, "
            "Documents, Spreadsheets, Videos, Music, Archives, Installers) — "
            "any folder on the user's PC, not just their personal ones. "
            "Never moves anything on the first call — it always previews the "
            "plan and asks the user to confirm first. If the result starts "
            "with 'CONFIRMATION_REQUIRED', relay it and wait; don't call "
            "this again for the same request."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "description": "Personal-folder name, drive letter, or full path."}
            },
            "required": ["root"],
        },
    },
    {
        "name": "remember_fact",
        "description": (
            "Remember a preference or fact about the user for future turns, "
            "e.g. their preferred editor or browser. Only call this when the "
            "user explicitly asks you to remember something."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Short label, e.g. 'editor', 'browser'."},
                "value": {"type": "string", "description": "The remembered value, e.g. 'VS Code'."},
            },
            "required": ["key", "value"],
        },
    },
    {
        "name": "forget_fact",
        "description": "Forget a previously remembered preference or fact by its key.",
        "input_schema": {
            "type": "object",
            "properties": {"key": {"type": "string"}},
            "required": ["key"],
        },
    },
    {
        "name": "list_routines",
        "description": "List the user's saved automation routines and what each one does.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "run_routine",
        "description": (
            "Request to run a saved automation routine (e.g. 'Gaming Mode'). "
            "This never runs anything on the first call — it always describes "
            "the steps and asks the user to confirm first. If the result "
            "starts with 'CONFIRMATION_REQUIRED', relay that question to the "
            "user and wait for their answer; do not call this tool again for "
            "the same request."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "The routine's name, e.g. 'Gaming Mode'."}},
            "required": ["name"],
        },
    },
]


def _to_function_calling_tools(tools: list[dict]) -> list[dict]:
    """Ollama (and most other local/OpenAI-compatible backends) expect
    OpenAI-style function-calling tools
    (`{"type": "function", "function": {"name", "description", "parameters"}}`),
    not the `{"name", "description", "input_schema"}` shape TOOLS is defined
    in above — same JSON Schema underneath, just wrapped differently.
    Converting here (rather than defining tools twice) means TOOLS stays the
    single source of truth for what JARVIS can do, reusable by any backend
    that speaks this common function-calling shape."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["input_schema"],
            },
        }
        for tool in tools
    ]


FUNCTION_CALLING_TOOLS = _to_function_calling_tools(TOOLS)

# Smaller local models occasionally misbehave around tool-calling in ways
# that have nothing to do with whether app.ai.backends actually parsed
# tool_calls correctly (confirmed separately: real tool calls, e.g. "what
# time is it", come back clean and structured every time). Two observed
# failure shapes, both a model/template quirk rather than anything wrong
# with the request: (1) wrapping an otherwise-normal reply in a stray JSON
# envelope like '{"type": "text", "text": "..."}', and (2) appending a
# hallucinated pseudo tool-call annotation like '(open_application,
# {"name": "X"})' after a normal sentence, without ever populating the real
# tool_calls field. Neither should ever reach the user as spoken/displayed
# text, so every backend reply is cleaned through this before use.
_JSON_WRAPPER_KEYS = ("text", "payload", "content", "message", "response")
# Seen both trailing ("...Settings? (open_application, {"name": "Settings"})")
# and mid-sentence ("...video (open_application, {"name": "YouTube"})? More
# text...") — stripped wherever it appears, not just at the end.
_FAKE_TOOL_CALL = re.compile(r"\(\s*[a-z_][a-z0-9_]*\s*,\s*\{.*?\}\s*\)")


def _extract_wrapped_text(value: object, depth: int = 0) -> str | None:
    """The JSON-envelope quirk isn't a single fixed shape — seen both
    `{"text": "..."}` and nested `{"type": "text", "data": {"text": "..."}}`
    — so this walks a few levels looking for a string under any known
    content-ish key rather than assuming one exact structure."""
    if depth > 3 or not isinstance(value, dict):
        return None
    for key in _JSON_WRAPPER_KEYS:
        found = value.get(key)
        if isinstance(found, str):
            return found
    for nested in value.values():
        found = _extract_wrapped_text(nested, depth + 1)
        if found is not None:
            return found
    return None


def _clean_model_content(content: str) -> str:
    text = content.strip()

    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        parsed = None
    extracted = _extract_wrapped_text(parsed) if isinstance(parsed, dict) else None
    if extracted is not None:
        text = extracted.strip()

    text = _FAKE_TOOL_CALL.sub("", text)
    text = re.sub(r"\s+([?.!,])", r"\1", text)  # no orphaned space before punctuation left behind
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text


_AFFIRMATIVE = {"yes", "yeah", "yep", "yup", "sure", "confirm", "confirmed", "do it", "go ahead", "ok", "okay"}
_NEGATIVE = {"no", "nope", "nah", "cancel", "don't", "dont", "stop", "never mind", "nevermind"}

_OPEN_PATTERN = re.compile(r"^(?:open|launch|start)\s+(.+)$", re.IGNORECASE)
_CLOSE_PATTERN = re.compile(r"^(?:close|quit|exit|stop)\s+(.+)$", re.IGNORECASE)
_SWITCH_PATTERN = re.compile(r"^(?:switch(?: window)? to|focus(?: on)?)\s+(.+)$", re.IGNORECASE)
_SETTINGS_PATTERN = re.compile(r"^open (?:windows |system )?settings$", re.IGNORECASE)
_FIND_FOLDER_PATTERN = re.compile(r"^find (?:a |the )?folder(?: called| named)?\s+(.+)$", re.IGNORECASE)
_SEARCH_FILE_PATTERN = re.compile(r"^(?:find|search for|look for)\s+(?:my\s+)?(.+)$", re.IGNORECASE)
_CREATE_FOLDER_PATTERN = re.compile(
    r"^create (?:a |the )?(?:new )?folder(?: called| named)?\s+([^,]+?)(?:\s+in\s+(\w+))?$", re.IGNORECASE
)
_RENAME_PATTERN = re.compile(r"^rename\s+(.+?)\s+to\s+(.+)$", re.IGNORECASE)
_ORGANIZE_PATTERN = re.compile(r"^organize\s+(?:my\s+)?(\w+)(?:\s+folder)?$", re.IGNORECASE)
_REMEMBER_KV_PATTERN = re.compile(r"^remember (?:that )?my (.+?) is (.+)$", re.IGNORECASE)
_REMEMBER_USE_PATTERN = re.compile(r"^remember (?:that )?i use (.+)$", re.IGNORECASE)
_FORGET_KEY_PATTERN = re.compile(r"^forget (?:that )?my (.+)$", re.IGNORECASE)
_FORGET_USE_PATTERN = re.compile(r"^forget (?:that )?i use (.+)$", re.IGNORECASE)
_LIST_MEMORY_PATTERN = re.compile(r"^what do you (?:remember|know)(?: about me)?\??$", re.IGNORECASE)
_RUN_ROUTINE_PATTERN = re.compile(r"^(?:run|start|activate|trigger)\s+(?:the\s+)?(.+)$", re.IGNORECASE)
_LIST_ROUTINES_PATTERN = re.compile(
    r"^(?:list|show)(?: my)? (?:routines|automations)\??$"
    r"|^what routines do (?:you|i) have\??$",
    re.IGNORECASE,
)

# Maps a whitelisted app name to the natural-language category most people
# would use for "remember I use X" — lets "Remember I use VS Code" resolve to
# the fact key "editor" without the user having to say "my editor is ..."
APP_CATEGORIES = {
    "notepad": "editor",
    "visual studio code": "editor",
    "vs code": "editor",
    "vscode": "editor",
    "chrome": "browser",
    "google chrome": "browser",
    "discord": "chat app",
    "steam": "game launcher",
    "calculator": "calculator",
    "paint": "image editor",
}


def _is_affirmative(text: str) -> bool:
    lowered = text.lower().strip().rstrip(".!")
    return lowered in _AFFIRMATIVE or any(lowered.startswith(w) for w in _AFFIRMATIVE)


def _is_negative(text: str) -> bool:
    lowered = text.lower().strip().rstrip(".!")
    return lowered in _NEGATIVE or any(lowered.startswith(w) for w in _NEGATIVE)


class AIManager:
    """One instance per backend process — see get_manager() below."""

    def __init__(self) -> None:
        self._memory = ConversationMemory()
        self._facts = FactMemory()
        self._routines = RoutineStore()
        self._permissions = PermissionManager()
        self._history = ActionLog()
        self._pending_confirmation: dict | None = None

    def is_connected(self) -> bool:
        """Whether the current AI backend is reachable right now — checked
        live (not cached), so starting/stopping it takes effect on the very
        next turn without restarting JARVIS."""
        return get_backend().is_available()

    def get_pending_confirmation(self) -> dict | None:
        """Whether a risky action is awaiting a yes/no, for the frontend's
        confirmation dialog — checked *after* respond() returns, since a
        fresh confirmation may have just been set by that same call."""
        if self._pending_confirmation is None:
            return None
        return {"kind": self._pending_confirmation["kind"], "prompt": self._pending_confirmation["prompt"]}

    def respond(self, text: str) -> str:
        memory_on = memory_config.is_memory_enabled()
        if memory_on:
            self._memory.add_turn("user", text)

        reply = self._handle_pending_confirmation(text)
        if reply is None:
            reply = self._respond_with_backend(text, memory_on) if get_backend().is_available() else self._respond_fallback(text)

        if memory_on:
            self._memory.add_turn("assistant", reply)
        return reply

    # ------------------------------------------------------------------
    # Confirmation flow (shared by both backend and fallback modes, and by
    # every kind of risky action — currently close_application and organize)
    # ------------------------------------------------------------------

    def _handle_pending_confirmation(self, text: str) -> str | None:
        if self._pending_confirmation is None:
            return None
        pending = self._pending_confirmation
        self._pending_confirmation = None

        if _is_affirmative(text):
            if pending["kind"] == "close_application":
                return self._execute_close(pending["name"])
            if pending["kind"] == "organize":
                return self._execute_organize(pending["moves"])
            if pending["kind"] == "run_routine":
                return self._execute_routine(pending["routine"])
            return None
        if _is_negative(text):
            if pending["kind"] == "close_application":
                return f"Okay, I won't close {pending['name']}."
            if pending["kind"] == "organize":
                return "Okay, I won't organize that folder."
            if pending["kind"] == "run_routine":
                return f"Okay, I won't run {pending['routine']['name']}."
            return None
        # Ambiguous reply: drop the pending confirmation rather than leave the
        # assistant stuck, and let this message fall through to normal handling.
        return None

    # ------------------------------------------------------------------
    # Fallback mode (backend not reachable): regex command parsing + responder
    # ------------------------------------------------------------------

    def _respond_fallback(self, text: str) -> str:
        control_reply = self._try_control_command(text)
        if control_reply is not None:
            return control_reply
        return responder.respond(text)

    def _try_control_command(self, text: str) -> str | None:
        stripped = text.strip().rstrip(".!?")

        if _LIST_MEMORY_PATTERN.match(stripped):
            return self._list_facts()

        if _LIST_ROUTINES_PATTERN.match(stripped):
            return self._list_routines()

        match = _RUN_ROUTINE_PATTERN.match(stripped)
        if match:
            candidate = match.group(1).strip()
            if self._routines.get_by_name(candidate) is not None:
                return self._request_run_routine(candidate, for_llm=False)
            # Not a known routine name (e.g. "start chrome") — fall through so
            # the app-open pattern below still gets a chance to handle it.

        match = _REMEMBER_KV_PATTERN.match(stripped)
        if match:
            return self._remember_fact(match.group(1).strip().lower(), match.group(2).strip())

        match = _REMEMBER_USE_PATTERN.match(stripped)
        if match:
            app_name = match.group(1).strip()
            category = APP_CATEGORIES.get(app_name.lower(), app_name.lower())
            return self._remember_fact(category, app_name)

        match = _FORGET_KEY_PATTERN.match(stripped)
        if match:
            return self._forget_fact(match.group(1).strip().lower())

        match = _FORGET_USE_PATTERN.match(stripped)
        if match:
            app_name = match.group(1).strip()
            category = APP_CATEGORIES.get(app_name.lower(), app_name.lower())
            return self._forget_fact(category)

        if _SETTINGS_PATTERN.match(stripped):
            return self._open_settings()

        match = _CLOSE_PATTERN.match(stripped)
        if match:
            return self._close_with_confirmation(match.group(1).strip(), for_llm=False)

        match = _ORGANIZE_PATTERN.match(stripped)
        if match:
            return self._organize_with_confirmation(match.group(1).strip(), for_llm=False)

        match = _CREATE_FOLDER_PATTERN.match(stripped)
        if match:
            name = match.group(1).strip()
            parent = (match.group(2) or "documents").strip()
            return self._create_folder(name, parent)

        match = _RENAME_PATTERN.match(stripped)
        if match:
            return self._rename_file(match.group(1).strip(), match.group(2).strip())

        match = _FIND_FOLDER_PATTERN.match(stripped)
        if match:
            return self._find_folders(match.group(1).strip())

        match = _OPEN_PATTERN.match(stripped)
        if match:
            return self._open(match.group(1).strip())

        match = _SWITCH_PATTERN.match(stripped)
        if match:
            return self._switch(match.group(1).strip())

        match = _SEARCH_FILE_PATTERN.match(stripped)
        if match:
            return self._search_files(match.group(1).strip())

        return None

    # ------------------------------------------------------------------
    # Backend mode (the current AI backend — Ollama today, see app.ai.backends)
    # ------------------------------------------------------------------

    def _build_system_prompt(self) -> str:
        if not memory_config.is_memory_enabled():
            return SYSTEM_PROMPT
        facts = self._facts.all()
        if not facts:
            return SYSTEM_PROMPT
        facts_lines = "\n".join(f"- {f['key']}: {f['value']}" for f in facts)
        return SYSTEM_PROMPT + f"\n\nPreferences already remembered about this user:\n{facts_lines}"

    def _respond_with_backend(self, text: str, memory_on: bool) -> str:
        backend = get_backend()
        messages = self._memory.recent_messages() if memory_on else [{"role": "user", "content": text}]
        full_messages = [{"role": "system", "content": self._build_system_prompt()}] + messages

        try:
            message = backend.chat(full_messages, tools=FUNCTION_CALLING_TOOLS)

            # Bounded rather than open-ended — a local model is less
            # predictable about ever actually stopping tool use on its own,
            # so this is a hard backstop against an infinite tool-call loop.
            for _ in range(6):
                tool_calls = message.get("tool_calls")
                if not tool_calls:
                    break
                full_messages.append({"role": "assistant", "content": message.get("content", ""), "tool_calls": tool_calls})
                for call in tool_calls:
                    fn = call.get("function", {})
                    result = self._run_tool(fn.get("name", ""), fn.get("arguments") or {})
                    full_messages.append({"role": "tool", "content": result})
                message = backend.chat(full_messages, tools=FUNCTION_CALLING_TOOLS)
        except AIBackendError:
            # A backend outage/error becomes a normal (if unhelpful) reply in
            # the conversation, not a 500 — the user is mid-conversation and
            # this should feel like a hiccup, not a crash.
            return "Sorry, I'm having trouble reaching the local AI right now. Try again in a moment."

        return _clean_model_content(message.get("content") or "")

    def _run_tool(self, name: str, tool_input: dict) -> str:
        if name == "get_current_time":
            return datetime.now().strftime("%I:%M %p").lstrip("0")
        if name == "get_current_date":
            return datetime.now().strftime("%A, %B %d, %Y")
        if name == "open_application":
            return self._open(tool_input.get("name", ""))
        if name == "close_application":
            return self._close_with_confirmation(tool_input.get("name", ""), for_llm=True)
        if name == "switch_window":
            return self._switch(tool_input.get("name", ""))
        if name == "open_settings":
            return self._open_settings()
        if name == "search_files":
            return self._search_files(tool_input.get("query", ""), tool_input.get("root"))
        if name == "find_folders":
            return self._find_folders(tool_input.get("query", ""), tool_input.get("root"))
        if name == "create_folder":
            return self._create_folder(tool_input.get("name", ""), tool_input.get("parent", "documents"))
        if name == "rename_file":
            return self._rename_file(
                tool_input.get("old_name", ""), tool_input.get("new_name", ""), tool_input.get("root")
            )
        if name == "organize_folder":
            return self._organize_with_confirmation(tool_input.get("root", ""), for_llm=True)
        if name == "remember_fact":
            return self._remember_fact(tool_input.get("key", ""), tool_input.get("value", ""))
        if name == "forget_fact":
            return self._forget_fact(tool_input.get("key", ""))
        if name == "list_routines":
            return self._list_routines()
        if name == "run_routine":
            return self._request_run_routine(tool_input.get("name", ""), for_llm=True)
        return f"Unknown tool: {name}"

    # ------------------------------------------------------------------
    # Memory helpers
    # ------------------------------------------------------------------

    def _resolve_alias(self, name: str) -> str:
        """If `name` looks like 'my X' and a fact for X is remembered, returns
        the remembered value instead (e.g. 'my editor' -> 'VS Code')."""
        if not memory_config.is_memory_enabled():
            return name
        stripped = name.strip().lower()
        if stripped.startswith("my "):
            key = stripped[3:].strip()
            remembered = self._facts.recall(key)
            if remembered:
                return remembered
        return name

    def _remember_fact(self, key: str, value: str) -> str:
        if not memory_config.is_memory_enabled():
            return "Memory is turned off in Settings, so I won't remember that."
        if not key or not value:
            return "I need both what to remember and its value."
        self._facts.remember(key, value)
        return f"Got it, I'll remember that your {key} is {value}."

    def _forget_fact(self, key: str) -> str:
        if not memory_config.is_memory_enabled():
            return "Memory is turned off in Settings."
        if self._facts.forget(key):
            return f"Okay, I've forgotten your {key}."
        return f"I didn't have anything remembered for '{key}'."

    def _list_facts(self) -> str:
        facts = self._facts.all()
        if not facts:
            return "I don't have anything remembered about you yet."
        lines = ", ".join(f"your {f['key']} is {f['value']}" for f in facts)
        return f"Here's what I remember: {lines}."

    # ------------------------------------------------------------------
    # Shared action helpers (permission-gated; the only path into app.control)
    # ------------------------------------------------------------------

    def _app_permission_denied(self) -> str:
        return "Permission denied: the 'Control applications' permission is not enabled. Enable it in Settings."

    def _fs_read_denied(self) -> str:
        return "Permission denied: the 'Search files' permission is not enabled. Enable it in Settings."

    def _fs_write_denied(self) -> str:
        return "Permission denied: the 'Manage files' permission is not enabled. Enable it in Settings."

    def _open(self, name: str) -> str:
        name = self._resolve_alias(name)
        if not self._permissions.is_granted(Scope.CONTROL_LAUNCH_APP):
            return self._app_permission_denied()
        result = actions.open_application(name)
        self._history.record("open_app", name, result)
        return result

    def _switch(self, name: str) -> str:
        name = self._resolve_alias(name)
        if not self._permissions.is_granted(Scope.CONTROL_LAUNCH_APP):
            return self._app_permission_denied()
        result = actions.switch_window(name)
        self._history.record("switch_window", name, result)
        return result

    def _open_settings(self) -> str:
        if not self._permissions.is_granted(Scope.CONTROL_LAUNCH_APP):
            return self._app_permission_denied()
        result = actions.open_windows_settings()
        self._history.record("open_settings", "", result)
        return result

    def _close_with_confirmation(self, name: str, *, for_llm: bool) -> str:
        name = self._resolve_alias(name)
        if not self._permissions.is_granted(Scope.CONTROL_LAUNCH_APP):
            return self._app_permission_denied()

        prompt = f"Do you want me to close {name}?"
        self._pending_confirmation = {"kind": "close_application", "name": name, "prompt": prompt}
        if for_llm:
            return (
                f"CONFIRMATION_REQUIRED: The user has not confirmed yet. Ask them "
                f"out loud whether they want to close {name} — do not say it is "
                f"closed. Their next message will be the answer; you do not need "
                f"to call this tool again."
            )
        return f"Do you want me to close {name}? Say yes to confirm."

    def _execute_close(self, name: str) -> str:
        if not self._permissions.is_granted(Scope.CONTROL_LAUNCH_APP):
            return "That permission was turned off before I could confirm, so I didn't close anything."
        result = actions.close_application(name)
        self._history.record("close_app", name, result)
        return result

    def _search_files(self, query: str, root: str | None = None) -> str:
        if not self._permissions.is_granted(Scope.FS_READ):
            return self._fs_read_denied()
        matches = files.search_files(query, root)
        if matches is None:
            return f"I couldn't find a location called '{root}'."
        if not matches:
            return f"I couldn't find any files matching '{query}'."
        names = [Path(p).name for p in matches[:8]]
        listing = ", ".join(names)
        more = f", and {len(matches) - 8} more" if len(matches) > 8 else ""
        return f"Found {len(matches)} file(s) matching '{query}': {listing}{more}."

    def _find_folders(self, query: str, root: str | None = None) -> str:
        if not self._permissions.is_granted(Scope.FS_READ):
            return self._fs_read_denied()
        matches = files.find_folders(query, root)
        if matches is None:
            return f"I couldn't find a location called '{root}'."
        if not matches:
            return f"I couldn't find any folders matching '{query}'."
        names = [Path(p).name for p in matches[:8]]
        listing = ", ".join(names)
        return f"Found {len(matches)} folder(s) matching '{query}': {listing}."

    def _create_folder(self, name: str, parent: str = "documents") -> str:
        if not self._permissions.is_granted(Scope.FS_WRITE):
            return self._fs_write_denied()
        result = files.create_folder(name, parent)
        self._history.record("create_folder", f"{name} in {parent}", result)
        return result

    def _rename_file(self, old_name: str, new_name: str, root: str | None = None) -> str:
        if not self._permissions.is_granted(Scope.FS_WRITE):
            return self._fs_write_denied()
        result = files.rename_file(old_name, new_name, root)
        self._history.record("rename_file", f"{old_name} -> {new_name}", result)
        return result

    def _organize_with_confirmation(self, root: str, *, for_llm: bool) -> str:
        if not self._permissions.is_granted(Scope.FS_WRITE):
            return self._fs_write_denied()

        moves = files.plan_organize(root)
        label = root.title() if root.strip().lower() in files.SAFE_ROOTS else root
        if not moves:
            return f"There's nothing in {label} that I know how to organize."

        categories = sorted({dest.parent.name for _, dest in moves})
        summary = f"I found {len(moves)} file(s) I can sort into {', '.join(categories)} folders in {label}."
        prompt = f"{summary} Do you want me to go ahead?"
        self._pending_confirmation = {"kind": "organize", "moves": moves, "prompt": prompt}
        if for_llm:
            return (
                f"CONFIRMATION_REQUIRED: {summary} Ask the user to confirm before "
                f"moving anything — do not say it's done. Their next message will "
                f"be the answer; you do not need to call this tool again."
            )
        return f"{summary} Do you want me to go ahead? Say yes to confirm."

    def _execute_organize(self, moves: list[tuple[Path, Path]]) -> str:
        if not self._permissions.is_granted(Scope.FS_WRITE):
            return "That permission was turned off before I could confirm, so I didn't move anything."
        result = files.execute_organize(moves)
        self._history.record("organize_folder", f"{len(moves)} file(s)", result)
        return result

    def _open_folder(self, root: str) -> str:
        if not self._permissions.is_granted(Scope.FS_READ):
            return self._fs_read_denied()
        return files.open_folder(root)

    def _check_performance(self) -> str:
        return system.check_performance()

    # ------------------------------------------------------------------
    # Automation routines (always confirmed before running — see
    # self._pending_confirmation, shared with close/organize above)
    # ------------------------------------------------------------------

    def _describe_step(self, step: dict) -> str:
        step_type, target = step["type"], step.get("target", "")
        if step_type == "open_app":
            return f"open {target}"
        if step_type == "switch_window":
            return f"switch to {target}"
        if step_type == "open_settings":
            return "open Settings"
        if step_type == "open_folder":
            return f"open the {target.title()} folder"
        if step_type == "check_performance":
            return "check PC performance"
        return step_type

    def _list_routines(self) -> str:
        routines = self._routines.all()
        if not routines:
            return "You don't have any automation routines yet. Create one from the Automations page."
        lines = [
            f"{r['name']} ({', '.join(self._describe_step(s) for s in r['steps'])})" for r in routines
        ]
        return "Here are your routines: " + "; ".join(lines) + "."

    def _request_run_routine(self, identifier: str, *, for_llm: bool) -> str:
        routine = self._routines.get_by_name(identifier) or self._routines.get(identifier)
        if routine is None:
            return f"I don't have a routine called '{identifier}'. Say 'what routines do I have?' to see them."
        if not routine["steps"]:
            return f"{routine['name']} doesn't have any steps yet."

        step_summary = ", then ".join(self._describe_step(s) for s in routine["steps"])
        prompt = f"Running {routine['name']} will: {step_summary}. Do you want me to go ahead?"
        self._pending_confirmation = {"kind": "run_routine", "routine": routine, "prompt": prompt}
        if for_llm:
            return (
                f"CONFIRMATION_REQUIRED: Running '{routine['name']}' will: "
                f"{step_summary}. Ask the user to confirm out loud before "
                f"running anything — do not say it's done. Their next message "
                f"will be the answer; you do not need to call this tool again."
            )
        return f"Running {routine['name']} will: {step_summary}. Say yes to confirm."

    def request_run_routine(self, identifier: str) -> str:
        """Public entry point for the Automations page's Run button — shares
        the exact same confirm-then-run path as "run <routine>" in chat."""
        return self._request_run_routine(identifier, for_llm=False)

    def _execute_routine(self, routine: dict) -> str:
        results = [self._execute_step(step) for step in routine["steps"]]
        summary = f"Ran {routine['name']}. " + " ".join(results)
        self._history.record("run_routine", routine["name"], summary)
        return summary

    def _execute_step(self, step: dict) -> str:
        step_type = step["type"]
        target = step.get("target", "")
        if step_type == "open_app":
            return self._open(target)
        if step_type == "switch_window":
            return self._switch(target)
        if step_type == "open_settings":
            return self._open_settings()
        if step_type == "open_folder":
            return self._open_folder(target)
        if step_type == "check_performance":
            return self._check_performance()
        return f"Unknown step: {step_type}."


_manager: AIManager | None = None


def get_manager() -> AIManager:
    global _manager
    if _manager is None:
        _manager = AIManager()
    return _manager
