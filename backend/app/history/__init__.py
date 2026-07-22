"""Action history: an append-only, capped record of actions JARVIS has
actually executed on the user's machine (opened/closed an app, moved files,
ran a routine, changed a permission) — distinct from app.memory, which stores
conversation content, not actions taken. Read-only from the outside; only
app.ai.manager (and app.security.permissions, for grant/revoke) ever writes
to it, at the point of actual execution, not at the point of request.
"""
