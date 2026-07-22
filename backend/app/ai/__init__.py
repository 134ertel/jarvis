"""AI reasoning and orchestration.

Owns deciding *what* the assistant should do in response to input. Never touches
the OS directly: manager.py calls a local Ollama model (see ollama_client.py),
and when the model requests an action, the manager checks app.security for a
grant before handing off to app.control, which actually executes. So the flow
is always:

    user text -> AIManager (understands) -> permission check -> app.control (acts)

manager.py falls back to responder.py's simple pattern matching when Ollama
isn't installed or isn't running, so the assistant still answers a few basic
commands out of the box without any setup — this project runs entirely for
free, with no API key and no account required.
"""
