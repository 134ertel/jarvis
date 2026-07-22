"""File assistant actions: search files, find folders, create folders, rename
files, and organize a folder's loose files into subfolders by type.

A location can be a personal-folder shortcut (SAFE_ROOTS — "desktop",
"documents", etc.), a drive letter ("C", "D:"), or any other absolute path —
search/organize/create/rename all work anywhere on disk the account running
JARVIS can reach, not just the personal folders. Search still defaults to the
personal folders when no location is named, purely so an everyday "find my
resume" stays fast — naming a drive or a path (e.g. "search my whole C
drive") reaches everywhere else.

No delete capability is exposed here at all — the requested capabilities were
search/find/organize/create/rename, not delete. If deletion is ever added
later, it must go through the same confirm-before-acting pattern
organize_folder already uses (see app.ai.manager's pending-confirmation flow),
never execute immediately.

Organizing *moves* files (shutil.move) rather than deleting anything — nothing
is lost, only relocated — but it's still a bulk operation across many files at
once, so the caller (app.ai.manager) always gets the user's explicit
confirmation before execute_organize() runs.

Walking beyond the personal folders means walking real Windows disks: some
subdirectories are permission-denied (per-user profile folders, protected
system paths), and Windows profile folders are full of reparse-point
junctions ("Application Data" -> "AppData\\Roaming" and similar) that would
recurse forever if followed. _walk_files/_walk_dirs use os.walk with
followlinks=False and a swallowed onerror so one locked-out folder doesn't
abort the whole search, plus a wall-clock time budget so naming a huge or
slow location (a whole drive with nothing matching) returns promptly instead
of hanging the request.
"""

import os
import re
import shutil
import time
from pathlib import Path
from typing import Iterator, Optional

SAFE_ROOTS: dict[str, Path] = {
    "desktop": Path.home() / "Desktop",
    "documents": Path.home() / "Documents",
    "downloads": Path.home() / "Downloads",
    "pictures": Path.home() / "Pictures",
    "music": Path.home() / "Music",
    "videos": Path.home() / "Videos",
}

CATEGORY_RULES: dict[str, set[str]] = {
    "Images": {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp"},
    "Documents": {".pdf", ".doc", ".docx", ".txt", ".rtf", ".odt"},
    "Spreadsheets": {".xls", ".xlsx", ".csv"},
    "Videos": {".mp4", ".mov", ".avi", ".mkv", ".webm"},
    "Music": {".mp3", ".wav", ".flac", ".aac"},
    "Archives": {".zip", ".rar", ".7z", ".tar", ".gz"},
    "Installers": {".exe", ".msi"},
}

_MAX_MATCHES = 50
_MAX_WALK_SECONDS = 8.0
# Not off-limits — just never worth descending into: near-inaccessible OS
# bookkeeping directories that are either permission-denied outright or
# enormous and never what a "find my X" search means.
_SKIP_DIR_NAMES = {"$recycle.bin", "system volume information"}

_DRIVE_PATTERN = re.compile(r"^[a-zA-Z](:\\?)?$")


def _resolve_location(location: str) -> Optional[Path]:
    """A single target location: a personal-folder alias, a drive letter, or
    any other absolute path that actually exists. None if it resolves to
    nothing real."""
    key = location.strip().lower()
    if key in SAFE_ROOTS:
        return SAFE_ROOTS[key]
    if _DRIVE_PATTERN.match(key):
        return Path(f"{key[0]}:\\")
    path = Path(location).expanduser()
    if path.exists() and path.is_dir():
        return path
    return None


def _resolve_search_roots(root: str | None) -> Optional[list[Path]]:
    """None -> every personal folder (the fast, common-case default).
    Otherwise a single resolved location, or None if it doesn't resolve —
    callers use that to report an unknown location distinctly from a
    known-but-empty one."""
    if root is None:
        return list(SAFE_ROOTS.values())
    location = _resolve_location(root)
    return [location] if location is not None else None


def _display_label(location: str, base: Path) -> str:
    """Personal-folder aliases get their nice title-cased name ("Documents");
    anything else (a drive, an arbitrary path) is shown as the real resolved
    path, since .title()-ing a path would mangle it."""
    return location.title() if location.strip().lower() in SAFE_ROOTS else str(base)


def _walk_files(base: Path) -> Iterator[Path]:
    deadline = time.monotonic() + _MAX_WALK_SECONDS
    for dirpath, dirnames, filenames in os.walk(base, onerror=lambda err: None, followlinks=False):
        if time.monotonic() > deadline:
            return
        dirnames[:] = [d for d in dirnames if d.lower() not in _SKIP_DIR_NAMES]
        for fname in filenames:
            yield Path(dirpath) / fname


def _walk_dirs(base: Path) -> Iterator[Path]:
    deadline = time.monotonic() + _MAX_WALK_SECONDS
    for dirpath, dirnames, _filenames in os.walk(base, onerror=lambda err: None, followlinks=False):
        if time.monotonic() > deadline:
            return
        dirnames[:] = [d for d in dirnames if d.lower() not in _SKIP_DIR_NAMES]
        for d in dirnames:
            yield Path(dirpath) / d


def _search_files_once(query_lower: str, roots: list[Path]) -> list[str]:
    matches: list[str] = []
    for base in roots:
        if not base.exists():
            continue
        for path in _walk_files(base):
            if query_lower in path.name.lower():
                matches.append(str(path))
                if len(matches) >= _MAX_MATCHES:
                    return matches
    return matches


def search_files(query: str, root: str | None = None) -> Optional[list[str]]:
    """Case-insensitive filename substring search. Read-only. Returns None if
    `root` was given but doesn't resolve to a real location.

    Falls back to the singular form when a plural query (e.g. "screenshots")
    has no exact matches — real screenshot/photo filenames are usually
    singular ("Screenshot 2024-01-15.png"), so a naive substring search on the
    plural the user actually says would otherwise come up empty.
    """
    roots = _resolve_search_roots(root)
    if roots is None:
        return None
    matches = _search_files_once(query.lower(), roots)
    if not matches and query.lower().endswith("s") and len(query) > 1:
        matches = _search_files_once(query.lower()[:-1], roots)
    return matches


def find_folders(query: str, root: str | None = None) -> Optional[list[str]]:
    """Case-insensitive folder-name substring search. Read-only. Returns None
    if `root` was given but doesn't resolve to a real location."""
    roots = _resolve_search_roots(root)
    if roots is None:
        return None
    query_lower = query.lower()
    matches: list[str] = []
    for base in roots:
        if not base.exists():
            continue
        for path in _walk_dirs(base):
            if query_lower in path.name.lower():
                matches.append(str(path))
                if len(matches) >= _MAX_MATCHES:
                    return matches
    return matches


def create_folder(name: str, parent: str = "documents") -> str:
    base = _resolve_location(parent)
    if base is None:
        return f"'{parent}' isn't a location I can create folders in."
    target = base / name
    try:
        target.mkdir(parents=False, exist_ok=False)
        return f"Created folder '{name}' in {_display_label(parent, base)}."
    except FileExistsError:
        return f"A folder named '{name}' already exists in {_display_label(parent, base)}."
    except OSError as err:
        return f"Couldn't create that folder: {err}"


def rename_file(old_name: str, new_name: str, root: str | None = None) -> str:
    roots = _resolve_search_roots(root)
    if roots is None:
        return f"I couldn't find a location called '{root}'."

    matches = [
        path
        for base in roots
        if base.exists()
        for path in _walk_files(base)
        if path.name.lower() == old_name.lower()
    ]

    if not matches:
        return f"I couldn't find a file named '{old_name}'."
    if len(matches) > 1:
        names = ", ".join(str(p) for p in matches[:5])
        return f"More than one file is named '{old_name}': {names}. Be more specific about which one."

    target = matches[0]
    new_path = target.with_name(new_name)
    if new_path.exists():
        return f"A file named '{new_name}' already exists there."
    try:
        target.rename(new_path)
        return f"Renamed '{old_name}' to '{new_name}'."
    except OSError as err:
        return f"Couldn't rename that file: {err}"


def open_folder(root: str) -> str:
    """Opens a folder in File Explorer. Read-only navigation — same tier as
    open_windows_settings, nothing is changed."""
    base = _resolve_location(root)
    if base is None:
        return f"'{root}' isn't a folder I can open."
    label = _display_label(root, base)
    try:
        os.startfile(str(base))
        return f"Opened {label} in File Explorer."
    except OSError as err:
        return f"Couldn't open {label}: {err}"


def _category_for(suffix: str) -> str | None:
    for category, extensions in CATEGORY_RULES.items():
        if suffix in extensions:
            return category
    return None


def plan_organize(root: str) -> list[tuple[Path, Path]]:
    """What organizing `root` would do — doesn't move anything yet. Only looks
    at loose files directly inside `root`, not subfolders, so it won't
    re-shuffle an already-organized folder."""
    base = _resolve_location(root)
    if base is None:
        return []
    moves = []
    try:
        entries = list(base.iterdir())
    except OSError:
        return []
    for path in entries:
        if not path.is_file():
            continue
        category = _category_for(path.suffix.lower())
        if category is None:
            continue
        moves.append((path, base / category / path.name))
    return moves


def execute_organize(moves: list[tuple[Path, Path]]) -> str:
    moved = 0
    for src, dest in moves:
        if dest.exists() or not src.exists():
            continue  # skip collisions/already-moved rather than overwrite
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest))
            moved += 1
        except OSError:
            continue
    return f"Organized {moved} file(s)."
