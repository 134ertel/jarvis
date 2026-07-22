"""Whether memory (conversation history + remembered facts/preferences) is
enabled at all.

Defaults to ON — unlike the security permission scopes, this isn't a
security-sensitive action. Each fact is opt-in by construction already (the
user has to explicitly say "remember ..." for anything to be stored at all),
so this toggle is a privacy opt-*out* for turning that off entirely, not a
default-deny gate on an OS-level action.

Turning it off stops new conversation turns and facts from being recorded, and
stops existing facts from being used to resolve things like "my editor" — it
does not retroactively erase what's already stored (that's what deleting a
memory, in the Memory view, is for).
"""

from app.settings.manager import SettingsManager

_settings = SettingsManager()


def is_memory_enabled() -> bool:
    return _settings.load().get("memory_enabled", True)


def set_memory_enabled(enabled: bool) -> None:
    data = _settings.load()
    data["memory_enabled"] = enabled
    _settings.save(data)
