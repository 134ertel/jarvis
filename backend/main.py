"""Entry point for the JARVIS backend.

Started as a child process by the Electron main process
(frontend/src/main/backendManager.ts). Boots the FastAPI app defined in
app/api/server.py on a loopback-only port.
"""

from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env explicitly by path rather than relying on the default
# cwd-search — when Electron spawns this process, its working directory is
# wherever Electron itself was launched from, not backend/.
load_dotenv(Path(__file__).parent / ".env")

import uvicorn

from app.core.config import settings
from app.core.logging_setup import configure_logging


def main() -> None:
    configure_logging()
    uvicorn.run(
        "app.api.server:app",
        host="127.0.0.1",
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    main()
