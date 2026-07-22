"""Security & permissions.

Defines permission scopes (e.g. control.mouse, control.keyboard, fs.read, fs.write)
and enforces default-deny with explicit user grant. app.control and app.memory must
check in here before acting; app.ai must not bypass it.
"""
