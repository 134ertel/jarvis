/**
 * Relays the backend's wake-word detections ("Hey Jarvis" / "Jarvis") into
 * the same "activate assistant" flow the tray menu's "Activate Assistant"
 * item already triggers (see index.ts's activateAssistant()) — so a wake
 * word does exactly what pressing the mic button does: open/focus the
 * window, navigate to Home, and start listening.
 *
 * Detection itself runs entirely in the backend (app.voice.wakeword, a local
 * offline model) and is only ever active when enabled from Settings — this
 * module just maintains a WebSocket connection to relay it, and stays
 * connected (reconnecting on drop) regardless of that setting, since an idle
 * connection is cheap and the backend simply won't push anything unless its
 * own listener is running.
 */

import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:8756/ws";
const RECONNECT_DELAY_MS = 2000;

let socket: WebSocket | null = null;
let stopped = true;

function connect(onWake: () => void): void {
  if (stopped) return;

  socket = new WebSocket(WS_URL);

  socket.on("message", (data: WebSocket.RawData) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed && parsed.event === "wake") onWake();
    } catch {
      // Ignore malformed frames rather than crash the main process over them.
    }
  });

  socket.on("close", () => {
    socket = null;
    if (!stopped) setTimeout(() => connect(onWake), RECONNECT_DELAY_MS);
  });

  socket.on("error", () => {
    // "close" always follows "error" for a WebSocket, which schedules the
    // reconnect — nothing further to do here besides not letting this throw.
  });
}

export function startWakewordBridge(onWake: () => void): void {
  stopped = false;
  connect(onWake);
}

export function stopWakewordBridge(): void {
  stopped = true;
  socket?.close();
  socket = null;
}
