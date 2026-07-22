/**
 * Spawns and supervises the Python backend process, if one is available.
 *
 * Starts backend/main.py, then continuously polls its /health endpoint (see
 * shared/ipc-contract.md) rather than trusting a one-time readiness check —
 * this is both how the renderer knows when it's safe to actually use the app
 * (see the "starting" status below, consumed by index.ts/Layout.tsx) and how
 * a genuine mid-session crash is detected and recovered from.
 *
 * If the process exits unexpectedly (not via stopBackend()'s intentional
 * stop), it's respawned automatically with backoff (1s/2s/4s/8s/16s, capped
 * at 5 attempts); the attempt counter resets once the respawned process has
 * been continuously healthy for HEALTHY_RESET_MS, so a flaky-but-recovering
 * backend doesn't get permanently penalized by earlier failures. Exhausting
 * all 5 attempts sets a terminal "crashed" status — surfaced persistently in
 * the UI rather than silently retrying forever.
 *
 * The packaged installer does not (yet) bundle the Python backend or a
 * runtime for it — this is UI packaging only. When the backend source isn't
 * present next to the app, or Python can't be spawned, this logs and leaves
 * status at "offline" so the window still opens; the sidebar's status dot
 * reflects that state instead of a hardcoded label.
 */

import { existsSync } from "fs";
import { spawn, ChildProcess } from "child_process";
import { join } from "path";

const BACKEND_DIR = join(__dirname, "../../../backend");
const BACKEND_ENTRY = join(BACKEND_DIR, "main.py");
const VENV_PYTHON = join(BACKEND_DIR, ".venv/Scripts/python.exe");
const HEALTH_URL = "http://127.0.0.1:8756/health";

const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 1000;
const RESPAWN_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const HEALTHY_RESET_MS = 30_000;

export type BackendStatus = "starting" | "online" | "offline" | "crashed";

let backendProcess: ChildProcess | null = null;
let intentionalStop = false;
let retryCount = 0;
let currentStatus: BackendStatus = "starting";
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let healthyStreakTimer: ReturnType<typeof setTimeout> | null = null;
let statusListeners: Array<(status: BackendStatus) => void> = [];

export function getBackendStatus(): BackendStatus {
  return currentStatus;
}

/** Lets a later-created window (opened from the tray after sitting hidden)
 * learn the real current state immediately, not just future transitions. */
export function onBackendStatusChange(callback: (status: BackendStatus) => void): () => void {
  statusListeners.push(callback);
  return () => {
    statusListeners = statusListeners.filter((listener) => listener !== callback);
  };
}

function setStatus(status: BackendStatus): void {
  if (status === currentStatus) return;
  currentStatus = status;
  for (const listener of statusListeners) listener(status);
}

async function pollHealth(): Promise<void> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`unhealthy: ${res.status}`);

    setStatus("online");
    if (!healthyStreakTimer) {
      healthyStreakTimer = setTimeout(() => {
        retryCount = 0;
        healthyStreakTimer = null;
      }, HEALTHY_RESET_MS);
    }
  } catch {
    if (healthyStreakTimer) {
      clearTimeout(healthyStreakTimer);
      healthyStreakTimer = null;
    }
    // Only downgrade a previously-online session to "offline" — an initial
    // "starting" boot or an already-"crashed" terminal state stay as-is,
    // since neither means "was fine, now isn't."
    if (currentStatus === "online") setStatus("offline");
  } finally {
    clearTimeout(timeoutHandle);
    pollTimer = setTimeout(() => void pollHealth(), POLL_INTERVAL_MS);
  }
}

function spawnProcess(): void {
  if (!existsSync(BACKEND_ENTRY)) {
    console.log("[backend] not found next to app, skipping (UI-only run)");
    setStatus("offline");
    return;
  }

  const pythonExe = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python";
  backendProcess = spawn(pythonExe, [BACKEND_ENTRY], { stdio: "inherit" });
  console.log(`[backend] spawned pid ${backendProcess.pid}`);

  backendProcess.on("error", (err) => {
    console.log(`[backend] failed to start: ${err.message}`);
    backendProcess = null;
    scheduleRespawn();
  });

  backendProcess.on("exit", (code) => {
    console.log(`[backend] exited with code ${code}`);
    backendProcess = null;
    if (!intentionalStop) scheduleRespawn();
  });
}

function scheduleRespawn(): void {
  if (intentionalStop) return;
  if (retryCount >= RESPAWN_BACKOFF_MS.length) {
    console.log("[backend] giving up after 5 respawn attempts");
    setStatus("crashed");
    return;
  }
  const delay = RESPAWN_BACKOFF_MS[retryCount];
  retryCount += 1;
  setStatus("starting");
  console.log(`[backend] respawning in ${delay}ms (attempt ${retryCount}/${RESPAWN_BACKOFF_MS.length})`);
  setTimeout(() => {
    if (!intentionalStop) spawnProcess();
  }, delay);
}

export function startBackend(): void {
  intentionalStop = false;
  retryCount = 0;
  setStatus("starting");
  spawnProcess();
  void pollHealth();
}

export function stopBackend(): void {
  intentionalStop = true;
  if (pollTimer) clearTimeout(pollTimer);
  if (healthyStreakTimer) clearTimeout(healthyStreakTimer);
  backendProcess?.kill();
  backendProcess = null;
}
