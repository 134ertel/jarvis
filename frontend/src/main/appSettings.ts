/**
 * Small persisted app settings that aren't OS-level login items (see autostart.ts
 * for those). Stored as a JSON file under Electron's userData directory.
 *
 * Microphone defaults to disabled — matches the default-deny posture already used
 * by the backend's security/permissions module (see ARCHITECTURE.md): access to a
 * sensitive input is opt-in, not opt-out.
 */

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

interface AppSettingsData {
  microphoneEnabled: boolean;
}

const DEFAULTS: AppSettingsData = {
  microphoneEnabled: false,
};

function settingsPath(): string {
  return join(app.getPath("userData"), "app-settings.json");
}

function load(): AppSettingsData {
  const path = settingsPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf-8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(data: AppSettingsData): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

export function isMicrophoneEnabled(): boolean {
  return load().microphoneEnabled;
}

export function setMicrophoneEnabled(enabled: boolean): void {
  const data = load();
  data.microphoneEnabled = enabled;
  save(data);
}
