"""Whether always-on wake-word listening ("Hey Jarvis" / "Jarvis") is enabled.

Off by default — unlike memory, this is a real behavior change (a background
microphone stream runs continuously while enabled) worth defaulting closed,
same posture as the app.security permission scopes. Persisted like
app.ai.config's model choice, through the same shared settings.json.
"""

from app.settings.manager import SettingsManager

_settings = SettingsManager()


def is_wakeword_enabled() -> bool:
    return _settings.load().get("wakeword_enabled", False)


def set_wakeword_enabled(enabled: bool) -> None:
    data = _settings.load()
    data["wakeword_enabled"] = enabled
    _settings.save(data)
