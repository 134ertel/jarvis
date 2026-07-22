"""Settings system.

Single source of truth for user-configurable options, persisted on disk. Any module
may read current settings; only this module's API may write them.
"""
