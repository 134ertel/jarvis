/**
 * System tray icon — what makes "background mode" actually reachable. While
 * minimized, JARVIS has no window open (minimal CPU/RAM) and just waits here for
 * the user to reopen it, activate it, or quit — the same pattern apps like Discord
 * or Spotify use.
 */

import { Tray, Menu, nativeImage } from "electron";
import { join } from "path";
import { isMicrophoneEnabled, setMicrophoneEnabled } from "./appSettings";

export interface TrayCallbacks {
  onOpen: () => void;
  onActivateAssistant: () => void;
  onOpenSettings: () => void;
  onQuit: () => void;
}

let tray: Tray | null = null;
let callbacks: TrayCallbacks = {
  onOpen: () => {},
  onActivateAssistant: () => {},
  onOpenSettings: () => {},
  onQuit: () => {},
};

export function createTray(cb: TrayCallbacks): Tray {
  callbacks = cb;

  const iconPath = join(__dirname, "../../build/icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip("JARVIS");
  tray.on("click", () => callbacks.onOpen());

  updateTrayMenu();
  return tray;
}

export function updateTrayMenu(): void {
  if (!tray) return;
  const micEnabled = isMicrophoneEnabled();

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open JARVIS", click: () => callbacks.onOpen() },
      { label: "Activate Assistant", click: () => callbacks.onActivateAssistant() },
      { type: "separator" },
      {
        label: "Enable Microphone",
        enabled: !micEnabled,
        click: () => {
          setMicrophoneEnabled(true);
          updateTrayMenu();
        },
      },
      {
        label: "Disable Microphone",
        enabled: micEnabled,
        click: () => {
          setMicrophoneEnabled(false);
          updateTrayMenu();
        },
      },
      { type: "separator" },
      { label: "Settings", click: () => callbacks.onOpenSettings() },
      { type: "separator" },
      { label: "Exit", click: () => callbacks.onQuit() },
    ]),
  );
}

export function getTray(): Tray | null {
  return tray;
}
