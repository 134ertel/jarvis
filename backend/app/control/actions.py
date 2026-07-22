"""Computer control actions.

Three layers, tried in order, for open/close/switch:
  1. WHITELISTED_APPS — a small curated set with hand-tuned close/switch
     window-title hints, kept for the apps this project has specific
     handling for.
  2. Dynamic discovery of every application in the Windows Start Menu (the
     same list the Start Menu itself shows) — this is what lets "open
     <anything actually installed>" work without hardcoding every possible
     app.
  3. WEBSITE_ALIASES (open only) — common sites like YouTube or Netflix,
     opened in the user's default browser, plus any plain domain/URL typed
     directly.

Still bounded, not "run anything": layer 2 only ever launches a real
installed application's own Start Menu shortcut, and layer 3 only ever opens
a URL in the browser — neither executes arbitrary commands or paths. The
caller (app.ai.manager) is responsible for checking app.security permissions
— and, for closing an app specifically, for getting the user's explicit
confirmation first — before calling into this module. This module only
executes.
"""

import os
import subprocess
from pathlib import Path
from typing import Optional

import win32com.client
import win32con
import win32gui

# Executable image names, used both to launch (os.startfile resolves these via
# Windows' "App Paths" registry entries, the same mechanism the Run dialog
# uses — more reliable than a hardcoded install path) and to find/close the
# running process (taskkill /IM).
WHITELISTED_APPS = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "paint": "mspaint.exe",
    "chrome": "chrome.exe",
    "google chrome": "chrome.exe",
    "discord": "Discord.exe",
    "visual studio code": "Code.exe",
    "vs code": "Code.exe",
    "vscode": "Code.exe",
    "steam": "steam.exe",
}

# Substrings to look for in a visible window's title, for switch_window —
# window titles are a simpler, reliable-enough signal than mapping a window
# back to its owning process/exe would be.
WINDOW_TITLE_HINTS = {
    "notepad": "Notepad",
    "calculator": "Calculator",
    "paint": "Paint",
    "chrome": "Google Chrome",
    "google chrome": "Google Chrome",
    "discord": "Discord",
    "visual studio code": "Visual Studio Code",
    "vs code": "Visual Studio Code",
    "vscode": "Visual Studio Code",
    "steam": "Steam",
}

# Common destinations that aren't installed applications — opened in the
# user's default browser via os.startfile, exactly like clicking a link.
WEBSITE_ALIASES = {
    "youtube": "https://www.youtube.com",
    "netflix": "https://www.netflix.com",
    "google": "https://www.google.com",
    "gmail": "https://mail.google.com",
    "amazon": "https://www.amazon.com",
    "spotify": "https://open.spotify.com",
    "twitter": "https://twitter.com",
    "x": "https://x.com",
    "facebook": "https://www.facebook.com",
    "instagram": "https://www.instagram.com",
    "reddit": "https://www.reddit.com",
    "whatsapp": "https://web.whatsapp.com",
    "whatsapp web": "https://web.whatsapp.com",
    "github": "https://github.com",
    "wikipedia": "https://www.wikipedia.org",
    "twitch": "https://www.twitch.tv",
    "disney plus": "https://www.disneyplus.com",
    "disney+": "https://www.disneyplus.com",
    "prime video": "https://www.primevideo.com",
    "hulu": "https://www.hulu.com",
}

_START_MENU_ROOTS = [
    Path(os.environ.get("ProgramData", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs",
    Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs",
]

_shell = None
_app_index_cache: Optional[dict[str, Path]] = None


def _get_shell():
    global _shell
    if _shell is None:
        _shell = win32com.client.Dispatch("WScript.Shell")
    return _shell


def _discover_apps() -> dict[str, Path]:
    """Every application shortcut in the Start Menu (per-user + all-users) —
    the same set Windows' own Start menu shows — mapped by lowercased display
    name to its .lnk file. Built once per backend process and cached: the
    Start Menu essentially never changes mid-session, and re-scanning disk on
    every request would be wasteful."""
    global _app_index_cache
    if _app_index_cache is not None:
        return _app_index_cache
    index: dict[str, Path] = {}
    for root in _START_MENU_ROOTS:
        if not root.exists():
            continue
        for shortcut in root.rglob("*.lnk"):
            index.setdefault(shortcut.stem.lower(), shortcut)
    _app_index_cache = index
    return index


def _resolve_target_exe(lnk_path: Path) -> Optional[str]:
    try:
        shortcut = _get_shell().CreateShortCut(str(lnk_path))
        target = shortcut.Targetpath
        return Path(target).name if target else None
    except Exception:
        return None


def _find_discovered(key: str) -> Optional[tuple[Path, str]]:
    """Best-effort match against the discovered Start Menu index — an exact
    name match first, then a substring match — returning
    (shortcut_path, display_name), or None if nothing matches."""
    index = _discover_apps()
    if key in index:
        return index[key], key
    for display_name, path in index.items():
        if key in display_name:
            return path, display_name
    return None


def open_application(name: str) -> str:
    """Opens a whitelisted app, any other installed application found via
    Start Menu discovery, or a known website — in that order."""
    key = name.lower().strip()

    executable = WHITELISTED_APPS.get(key)
    if executable is not None:
        try:
            os.startfile(executable)
            return f"Opened {name}."
        except OSError as err:
            return f"Couldn't open {name}: {err}"

    found = _find_discovered(key)
    if found is not None:
        shortcut_path, display_name = found
        try:
            os.startfile(str(shortcut_path))
            return f"Opened {display_name.title()}."
        except OSError as err:
            return f"Couldn't open {display_name}: {err}"

    url = WEBSITE_ALIASES.get(key)
    if url is None and "." in key and " " not in key:
        # A plain domain/URL typed directly, e.g. "open example.com".
        url = key if key.startswith(("http://", "https://")) else f"https://{key}"
    if url is not None:
        try:
            os.startfile(url)
            return f"Opening {name} in your browser."
        except OSError as err:
            return f"Couldn't open {name}: {err}"

    return f"I couldn't find an application or website called '{name}'."


# Windows silently redirects a few inbox exes to a modern UWP-hosted app at
# launch time, under a different process name than the exe used to start it —
# taskkill needs the real name, which also varies by Windows version, so try
# each known candidate in turn. Only calc.exe is affected among the curated
# whitelist; the rest are ordinary desktop executables.
CLOSE_CANDIDATES = {
    "calc.exe": ["CalculatorApp.exe", "Calculator.exe", "calc.exe"],
}


def _taskkill(executable: str, display_name: str) -> str:
    for candidate in CLOSE_CANDIDATES.get(executable, [executable]):
        result = subprocess.run(
            ["taskkill", "/IM", candidate, "/F"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return f"Closed {display_name}."
    return f"{display_name} doesn't appear to be running."


def close_application(name: str) -> str:
    """Force-closes a running whitelisted or discovered app. Callers must get
    explicit user confirmation before calling this — see AIManager's
    confirmation flow."""
    key = name.lower().strip()

    executable = WHITELISTED_APPS.get(key)
    if executable is not None:
        return _taskkill(executable, name)

    found = _find_discovered(key)
    if found is not None:
        shortcut_path, display_name = found
        exe_name = _resolve_target_exe(shortcut_path)
        if exe_name is None:
            return f"I couldn't determine {display_name}'s process to close it."
        return _taskkill(exe_name, display_name)

    return f"'{name}' is not an application I can close."


def switch_window(name: str) -> str:
    key = name.lower().strip()
    hint = WINDOW_TITLE_HINTS.get(key)
    display_name = name

    if hint is None:
        found = _find_discovered(key)
        if found is None:
            return f"'{name}' is not an application I can switch to."
        _, display_name = found
        hint = display_name

    matches: list[int] = []

    def _collect(hwnd: int, _: object) -> bool:
        if win32gui.IsWindowVisible(hwnd):
            title = win32gui.GetWindowText(hwnd)
            if title and hint.lower() in title.lower():
                matches.append(hwnd)
        return True

    win32gui.EnumWindows(_collect, None)

    if not matches:
        return f"I couldn't find an open window for {display_name}."

    hwnd = matches[0]
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
        return f"Switched to {display_name}."
    except Exception as err:
        # Windows can refuse to hand over the foreground depending on what
        # currently holds focus-lock — a known OS quirk, not a bug here.
        return f"Found {display_name}'s window but couldn't bring it to the front: {err}"


def open_windows_settings() -> str:
    try:
        os.startfile("ms-settings:")
        return "Opening Windows Settings."
    except OSError as err:
        return f"Couldn't open Settings: {err}"
