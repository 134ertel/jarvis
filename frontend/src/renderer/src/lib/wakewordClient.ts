/**
 * Client for the backend's wake-word toggle — see app.voice.wakeword_config
 * and the /api/voice/wakeword routes in app.api.server. Detection itself runs
 * entirely in the backend (a local, offline model); this only turns it on/off
 * and reports whether the background listener actually started.
 */

const BACKEND_URL = "http://127.0.0.1:8756";

export interface WakewordStatus {
  enabled: boolean;
  running: boolean;
  paused?: boolean;
}

export async function getWakewordEnabled(): Promise<WakewordStatus> {
  const res = await fetch(`${BACKEND_URL}/api/voice/wakeword`);
  if (!res.ok) throw new Error(`wakeword status fetch failed: ${res.status}`);
  return res.json();
}

export async function setWakewordEnabled(enabled: boolean): Promise<WakewordStatus> {
  const res = await fetch(`${BACKEND_URL}/api/voice/wakeword`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `wakeword toggle failed: ${res.status}`);
  }
  return res.json();
}

/** Tells the backend a wake-triggered conversation has ended (mutual silence,
 * or the user manually left voice mode) so it starts reacting to the wake
 * phrase again. Fire-and-forget from the renderer's point of view — the
 * backend also self-heals on its own after a long timeout if this is ever
 * missed (e.g. a crash mid-conversation), so a failed call here isn't fatal. */
export async function resumeWakewordListening(): Promise<void> {
  await fetch(`${BACKEND_URL}/api/voice/wakeword/resume-listening`, { method: "POST" }).catch(() => {});
}
