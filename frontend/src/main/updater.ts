/**
 * Wraps electron-updater's autoUpdater.
 *
 * Guarded behind app.isPackaged — electron-updater has no packaged
 * update-metadata to compare against in a dev run and will error out
 * immediately, which is the correct behavior here, not a bug to work around.
 *
 * autoDownload is deliberately off: the user explicitly triggers a download
 * via "Check for updates" in Settings, rather than JARVIS silently
 * downloading in the background. There's no real release channel configured
 * yet (see package.json's build.publish — the owner/repo there are
 * placeholders until a real GitHub repo exists), so an unattended background
 * download failing repeatedly would be a worse experience than an explicit,
 * visible action the user chose.
 */

import { app } from "electron";
import { autoUpdater } from "electron-updater";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "not-available" }
  | { state: "error"; message: string }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string };

let statusListeners: Array<(status: UpdateStatus) => void> = [];
let wired = false;

export function onUpdateStatusChange(callback: (status: UpdateStatus) => void): () => void {
  statusListeners.push(callback);
  return () => {
    statusListeners = statusListeners.filter((listener) => listener !== callback);
  };
}

function emit(status: UpdateStatus): void {
  for (const listener of statusListeners) listener(status);
}

// electron-updater's real error messages are technical (HTTP status codes,
// provider-internal wording like "double check your authentication token")
// — meaningless to an end user and not something JARVIS's UI voice should
// surface verbatim. Log the real one for whoever's debugging; show a plain
// one in the UI.
function emitError(err: Error): void {
  console.error("[updater]", err);
  emit({ state: "error", message: "Couldn't check for updates. Try again later." });
}

function ensureWired(): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false;
  autoUpdater.on("checking-for-update", () => emit({ state: "checking" }));
  autoUpdater.on("update-available", (info) => emit({ state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => emit({ state: "not-available" }));
  autoUpdater.on("error", emitError);
  autoUpdater.on("download-progress", (progress) =>
    emit({ state: "downloading", percent: Math.round(progress.percent) })
  );
  autoUpdater.on("update-downloaded", (info) => emit({ state: "downloaded", version: info.version }));
}

export function checkForUpdates(): void {
  if (!app.isPackaged) {
    emit({ state: "error", message: "Updates only work in a packaged, installed build — not this dev run." });
    return;
  }
  ensureWired();
  emit({ state: "checking" });
  autoUpdater.checkForUpdates().catch(emitError);
}

export function downloadUpdate(): void {
  if (!app.isPackaged) return;
  ensureWired();
  autoUpdater.downloadUpdate().catch(emitError);
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

export function getAppVersion(): string {
  return app.getVersion();
}
