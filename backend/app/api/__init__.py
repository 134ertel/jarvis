"""API layer exposed to the Electron frontend.

This is the only module the Electron main process talks to. It owns the FastAPI app
and routes requests into the appropriate module (ai, voice, control, memory,
settings, security). It contains no business logic of its own.
"""
