/**
 * Secure bridge between the renderer (untrusted web content) and the main process.
 *
 * The renderer never gets Node or Electron APIs directly (contextIsolation +
 * sandbox are on). Everything it can do is explicitly whitelisted here. Only the
 * settings channels and the two tray-driven navigation events exist so far — other
 * module APIs (ai, voice, control, memory, security) will be added as bridge
 * methods once implemented.
 */

import { contextBridge, ipcRenderer } from "electron";

function subscribe(channel: string, callback: (...args: unknown[]) => void): () => void {
  const listener = (_event: unknown, ...args: unknown[]): void => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  versions: process.versions,
  settings: {
    getAutostart: (): Promise<boolean> => ipcRenderer.invoke("settings:get-autostart"),
    setAutostart: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke("settings:set-autostart", enabled),
    getMicrophone: (): Promise<boolean> => ipcRenderer.invoke("settings:get-microphone"),
    setMicrophone: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke("settings:set-microphone", enabled),
  },
  // Fired by the tray menu ("Settings" / "Activate Assistant") to drive the UI
  // from outside the window itself.
  onNavigate: (callback: (view: string) => void): (() => void) =>
    subscribe("nav:go", (view) => callback(view as string)),
  onActivateAssistant: (callback: () => void): (() => void) => subscribe("assistant:activate", () => callback()),
  // Distinct from onActivateAssistant — fired specifically by a wake-word
  // detection (see main/wakewordBridge.ts), never by the tray/manual path.
  onWakeTriggered: (callback: () => void): (() => void) => subscribe("wake:triggered", () => callback()),
  // Real backend health, not a hardcoded label — see backendManager.ts.
  // "starting" | "online" | "offline" | "crashed". getBackendStatus() gives
  // the current value (for a component mounting after the window already
  // loaded); onBackendStatus gives future changes.
  getBackendStatus: (): Promise<string> => ipcRenderer.invoke("backend:get-status"),
  onBackendStatus: (callback: (status: string) => void): (() => void) =>
    subscribe("backend:status", (status) => callback(status as string)),
  updates: {
    getVersion: (): Promise<string> => ipcRenderer.invoke("updates:get-version"),
    check: (): Promise<void> => ipcRenderer.invoke("updates:check"),
    download: (): Promise<void> => ipcRenderer.invoke("updates:download"),
    install: (): Promise<void> => ipcRenderer.invoke("updates:install"),
    onStatus: (callback: (status: unknown) => void): (() => void) => subscribe("update:status", callback),
  },
};

contextBridge.exposeInMainWorld("jarvis", api);

export type JarvisApi = typeof api;
