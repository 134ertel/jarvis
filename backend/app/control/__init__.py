"""Computer control system.

The only module permitted to perform OS-level actions: keyboard/mouse input, file
access, launching or controlling other processes. Every action must be checked
against app.security by the caller before this module runs it — see
app.ai.manager for the permission-check-then-execute flow.

Two areas so far:

- **actions.py** — a fixed whitelist of applications: open, close (force-close
  via taskkill), switch to (bring an open window to the foreground), plus
  opening Windows Settings.
- **files.py** — search files, find folders, create folders, rename files, and
  organize a folder's loose files into type-based subfolders. Scoped to the
  user's own personal folders (Desktop/Documents/Downloads/Pictures/Music/
  Videos) only. No delete capability exists anywhere in this module.

Nothing here deletes files or changes system configuration; that's explicitly
out of scope for now. Closing an app and organizing a folder are never executed
without the user confirming first (closing can lose unsaved work; organizing
moves many files at once) — see AIManager's confirmation flow, not anything in
this module.

Broader control (mouse, keyboard, arbitrary files outside the personal folders)
is future work; add it here, following the same pattern, not by calling the OS
directly from app.ai.
"""
