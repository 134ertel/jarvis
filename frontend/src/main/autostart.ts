/**
 * Windows "start with Windows" control.
 *
 * Backed by Electron's login item API, which reads/writes the same HKCU
 * `...\Run` registry value that the NSIS installer's optional startup checkbox
 * writes at install time (see build/installer.nsh). Whichever one last changed it,
 * the other sees the same state — there is only one source of truth, and the user
 * can flip it any time from Settings.
 *
 * When Windows launches the app at login, it passes --hidden (set below), which
 * main/index.ts checks via wasLaunchedHidden() to skip creating a window and stay
 * tray-only until the user asks for it.
 */

import { app } from "electron";

const HIDDEN_ARG = "--hidden";
// Electron only reports openAtLogin correctly when getLoginItemSettings() is
// queried with the same args that were passed to setLoginItemSettings() — passing
// no args on read silently mismatches an entry that was set with args and always
// reads back as false. Always query with the same fixed args for consistency.
const LOGIN_ITEM_ARGS = [HIDDEN_ARG];

export function setAutostart(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: LOGIN_ITEM_ARGS,
  });
}

export function isAutostartEnabled(): boolean {
  return app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).openAtLogin;
}

export function wasLaunchedHidden(): boolean {
  return (
    process.argv.includes(HIDDEN_ARG) ||
    app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).wasOpenedAtLogin
  );
}
