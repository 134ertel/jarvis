"""Automations: named, ordered routines the user builds once and runs later
with a single command (e.g. "Gaming Mode" -> open Discord, open Steam, check
PC performance).

`routines.py` owns the store — CRUD for saved routines, persisted like
app.memory.facts. Running a routine is orchestrated by app.ai.manager, which
always asks for confirmation first, exactly like closing an app or organizing
a folder — a routine is just a pre-recorded sequence of actions app.control
already exposes individually, not a new capability or a way around Security.
"""
