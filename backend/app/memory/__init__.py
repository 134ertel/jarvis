"""Memory system.

Persistent conversation history, context, and learned preferences. Owns its own
storage and exposes a narrow read/write API — other modules never touch storage
directly.

- **store.py** — `ConversationMemory`: raw recent chat turns, fed to the local
  Ollama model as context.
- **facts.py** — `FactMemory`: named preferences the user explicitly asked
  JARVIS to remember (e.g. "Remember I use VS Code"), used both for direct
  recall ("what do you remember?") and to resolve aliases like "my editor"
  when opening/closing/switching to an application.
- **config.py** — the on/off switch for all of the above (`is_memory_enabled`
  / `set_memory_enabled`), controllable from Settings.
"""
