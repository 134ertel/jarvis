/**
 * IPC handlers exposed to the renderer through the preload bridge. Only the
 * settings channels used by the Startup and Microphone toggles exist so far —
 * other modules (ai, voice, control, memory, security) will register their own
 * channels here once they exist.
 */

import { ipcMain } from "electron";
import { isAutostartEnabled, setAutostart } from "./autostart";
import { isMicrophoneEnabled, setMicrophoneEnabled } from "./appSettings";
import { updateTrayMenu } from "./tray";
import { getBackendStatus } from "./backendManager";
import { getAppVersion, checkForUpdates, downloadUpdate, quitAndInstall } from "./updater";

export function registerIpcHandlers(): void {
  // Lets a component mounting well after the window's initial load (e.g. the
  // Settings/Automations/Memory pages, opened later via sidebar navigation)
  // learn the *current* backend status immediately, rather than only ever
  // future status-change pushes it would otherwise have missed entirely.
  ipcMain.handle("backend:get-status", () => getBackendStatus());

  ipcMain.handle("updates:get-version", () => getAppVersion());
  ipcMain.handle("updates:check", () => checkForUpdates());
  ipcMain.handle("updates:download", () => downloadUpdate());
  ipcMain.handle("updates:install", () => quitAndInstall());

  ipcMain.handle("settings:get-autostart", () => isAutostartEnabled());

  ipcMain.handle("settings:set-autostart", (_event, enabled: boolean) => {
    setAutostart(Boolean(enabled));
    updateTrayMenu();
    return isAutostartEnabled();
  });

  ipcMain.handle("settings:get-microphone", () => isMicrophoneEnabled());

  ipcMain.handle("settings:set-microphone", (_event, enabled: boolean) => {
    setMicrophoneEnabled(Boolean(enabled));
    updateTrayMenu();
    return isMicrophoneEnabled();
  });
}
