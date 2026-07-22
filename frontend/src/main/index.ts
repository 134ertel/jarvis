/**
 * Electron main process entry point.
 *
 * Owns window/tray lifecycle, Windows autostart registration, and supervision of the
 * Python backend process. Contains no AI, voice, or automation logic — that all
 * lives in the Python backend and is reached only through the preload bridge.
 *
 * Background mode: when launched at Windows login (wasLaunchedHidden), no window is
 * created at all — only the tray icon and the backend process exist, so the app
 * sits idle using minimal CPU/RAM until the user opens it from the tray. Closing the
 * window normally hides it to the tray instead of quitting, for the same reason —
 * matching the Discord/Spotify-style "minimize to tray, keep running" convention.
 */

import { app, BrowserWindow, session } from "electron";
import { join } from "path";
import { wasLaunchedHidden } from "./autostart";
import { isMicrophoneEnabled } from "./appSettings";
import { startBackend, stopBackend, getBackendStatus, onBackendStatusChange } from "./backendManager";
import { createTray, getTray } from "./tray";
import { registerIpcHandlers } from "./ipc";
import { onUpdateStatusChange } from "./updater";
import { startWakewordBridge, stopWakewordBridge } from "./wakewordBridge";

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let hasShownTrayNotice = false;

// Without an explicit AppUserModelId, Electron falls back to a synthetic
// "electron.app.<name>" identity on Windows and uses it as the registry value
// name for login items. Setting this explicitly keeps that name stable and
// matching what build/installer.nsh writes directly.
app.setAppUserModelId("JARVIS");

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function createWindow(showImmediately: boolean): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#05060a",
    show: false,
    icon: join(__dirname, "../../build/icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (showImmediately) mainWindow?.show();
  });

  // A window created well after the backend finished booting (e.g. opened
  // from the tray after sitting hidden at login) needs to learn the current
  // status immediately — otherwise it would default to "connecting" forever,
  // since it missed every status change that happened before it existed.
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow?.webContents.send("backend:status", getBackendStatus());
  });

  // Hide to tray instead of quitting, unless we're actually shutting down or have
  // no tray to fall back on (in which case closing should behave normally).
  mainWindow.on("close", (event) => {
    if (!isQuitting && getTray()) {
      event.preventDefault();
      mainWindow?.hide();

      if (!hasShownTrayNotice) {
        hasShownTrayNotice = true;
        getTray()?.displayBalloon({
          title: "JARVIS is still running",
          content: "JARVIS is running in the background. Click the tray icon to reopen it.",
        });
      }
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Ensures a window exists and has finished loading before running `action` against
 * it — sending IPC to a window that was just created would arrive before the
 * renderer's listeners are mounted and get silently dropped.
 */
function withWindow(action: () => void): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    mainWindow?.webContents.once("did-finish-load", action);
    return;
  }
  showMainWindow();
  action();
}

function openSettings(): void {
  withWindow(() => mainWindow?.webContents.send("nav:go", "settings"));
}

function activateAssistant(): void {
  withWindow(() => {
    mainWindow?.webContents.send("nav:go", "home");
    mainWindow?.webContents.send("assistant:activate");
  });
}

// Distinct from activateAssistant: a wake-word detection should always
// *start* a conversation, never toggle an existing one off, and the renderer
// needs to know it specifically was wake-triggered (chime + "Yes?", and
// auto-return to wake-word-only listening after mutual silence — see
// useVoiceConversation.ts's startFromWakeWord) rather than treat it like a
// manual mic press.
function handleWakeWordTriggered(): void {
  withWindow(() => {
    mainWindow?.webContents.send("nav:go", "home");
    mainWindow?.webContents.send("wake:triggered");
  });
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    startBackend();
    startWakewordBridge(handleWakeWordTriggered);

    onBackendStatusChange((status) => {
      mainWindow?.webContents.send("backend:status", status);
      if (status === "crashed") {
        getTray()?.displayBalloon({
          title: "JARVIS backend stopped responding",
          content: "JARVIS couldn't reconnect to its backend after several attempts. Restart JARVIS to try again.",
        });
      }
    });

    onUpdateStatusChange((status) => {
      mainWindow?.webContents.send("update:status", status);
    });

    // Defense in depth: even if the renderer requests microphone access, deny it
    // at the OS-integration layer unless the user has actually enabled the
    // Microphone setting (tray menu / Settings). This is the same "user always
    // controls this option" rule the Startup toggle follows.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "media" && isMicrophoneEnabled());
    });

    createTray({
      onOpen: showMainWindow,
      onActivateAssistant: activateAssistant,
      onOpenSettings: openSettings,
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
    });

    if (!wasLaunchedHidden()) {
      createWindow(true);
    }

    app.on("activate", () => {
      showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    // Only quit here if there's no tray to fall back on — normally the window
    // hides instead of closing, so this fires solely in that fallback case.
    if (!getTray()) {
      stopBackend();
      app.quit();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    stopBackend();
    stopWakewordBridge();
  });
}
