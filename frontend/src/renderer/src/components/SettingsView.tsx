import { useEffect, useState } from "react";
import { getPermissions, setPermission } from "../lib/aiClient";
import { getMemoryEnabled, setMemoryEnabled } from "../lib/memoryClient";
import { getRecentActions, type ActionEntry } from "../lib/historyClient";
import { getWakewordEnabled, setWakewordEnabled } from "../lib/wakewordClient";
import { useBackendStatus } from "../hooks/useBackendStatus";

const LAUNCH_APP_SCOPE = "control.launch_app";
const FS_READ_SCOPE = "fs.read";
const FS_WRITE_SCOPE = "fs.write";

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "not-available" }
  | { state: "error"; message: string }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string };

function isUpdateStatus(value: unknown): value is UpdateStatus {
  return typeof value === "object" && value !== null && "state" in value;
}

export default function SettingsView(): JSX.Element {
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [savingAutostart, setSavingAutostart] = useState(false);

  const [micEnabled, setMicEnabledState] = useState<boolean | null>(null);
  const [savingMic, setSavingMic] = useState(false);

  const [wakewordEnabled, setWakewordEnabledState] = useState<boolean | null>(null);
  const [savingWakeword, setSavingWakeword] = useState(false);
  const [wakewordError, setWakewordError] = useState<string | null>(null);

  const [launchAppGranted, setLaunchAppGranted] = useState<boolean | null>(null);
  const [savingPermission, setSavingPermission] = useState(false);

  const [fsReadGranted, setFsReadGranted] = useState<boolean | null>(null);
  const [savingFsRead, setSavingFsRead] = useState(false);

  const [fsWriteGranted, setFsWriteGranted] = useState<boolean | null>(null);
  const [savingFsWrite, setSavingFsWrite] = useState(false);

  const [memoryEnabled, setMemoryEnabledState] = useState<boolean | null>(null);
  const [savingMemory, setSavingMemory] = useState(false);

  const [recentActions, setRecentActions] = useState<ActionEntry[] | null>(null);
  const backendStatus = useBackendStatus();

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle" });

  function loadBackendState(): void {
    getPermissions()
      .then((perms) => {
        setLaunchAppGranted(Boolean(perms[LAUNCH_APP_SCOPE]));
        setFsReadGranted(Boolean(perms[FS_READ_SCOPE]));
        setFsWriteGranted(Boolean(perms[FS_WRITE_SCOPE]));
      })
      .catch(() => {
        setLaunchAppGranted(null);
        setFsReadGranted(null);
        setFsWriteGranted(null);
      });
    getMemoryEnabled()
      .then((status) => setMemoryEnabledState(status.enabled))
      .catch(() => setMemoryEnabledState(null));
    getRecentActions(10)
      .then((data) => setRecentActions(data.actions))
      .catch(() => setRecentActions(null));
    getWakewordEnabled()
      .then((status) => setWakewordEnabledState(status.enabled))
      .catch(() => setWakewordEnabledState(null));
  }

  useEffect(() => {
    window.jarvis.settings.getAutostart().then(setAutostartState);
    window.jarvis.settings.getMicrophone().then(setMicEnabledState);
    loadBackendState();
    window.jarvis.updates.getVersion().then(setAppVersion);
    return window.jarvis.updates.onStatus((status) => {
      if (isUpdateStatus(status)) setUpdateStatus(status);
    });
  }, []);

  // Retry the backend-derived cards automatically once it's back online —
  // catches both "was down when this page first loaded" and "crashed while
  // this page was already open."
  useEffect(() => {
    if (backendStatus === "online") loadBackendState();
  }, [backendStatus]);

  function formatActionTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  async function toggleAutostart(): Promise<void> {
    if (autostart === null || savingAutostart) return;
    setSavingAutostart(true);
    const next = await window.jarvis.settings.setAutostart(!autostart);
    setAutostartState(next);
    setSavingAutostart(false);
  }

  async function toggleMic(): Promise<void> {
    if (micEnabled === null || savingMic) return;
    setSavingMic(true);
    const next = await window.jarvis.settings.setMicrophone(!micEnabled);
    setMicEnabledState(next);
    setSavingMic(false);
  }

  async function toggleWakeword(): Promise<void> {
    if (wakewordEnabled === null || savingWakeword) return;
    setSavingWakeword(true);
    setWakewordError(null);
    try {
      const result = await setWakewordEnabled(!wakewordEnabled);
      setWakewordEnabledState(result.enabled);
      if (result.enabled && !result.running) {
        setWakewordError("Enabled, but the listener didn't start — check that a microphone is connected.");
      }
    } catch (err) {
      setWakewordError(err instanceof Error ? err.message : "Couldn't change wake-word listening.");
    } finally {
      setSavingWakeword(false);
    }
  }

  async function toggleLaunchAppPermission(): Promise<void> {
    if (launchAppGranted === null || savingPermission) return;
    setSavingPermission(true);
    try {
      const result = await setPermission(LAUNCH_APP_SCOPE, !launchAppGranted);
      setLaunchAppGranted(result.granted);
    } finally {
      setSavingPermission(false);
    }
  }

  async function toggleFsRead(): Promise<void> {
    if (fsReadGranted === null || savingFsRead) return;
    setSavingFsRead(true);
    try {
      const result = await setPermission(FS_READ_SCOPE, !fsReadGranted);
      setFsReadGranted(result.granted);
    } finally {
      setSavingFsRead(false);
    }
  }

  async function toggleFsWrite(): Promise<void> {
    if (fsWriteGranted === null || savingFsWrite) return;
    setSavingFsWrite(true);
    try {
      const result = await setPermission(FS_WRITE_SCOPE, !fsWriteGranted);
      setFsWriteGranted(result.granted);
    } finally {
      setSavingFsWrite(false);
    }
  }

  function checkForUpdates(): void {
    window.jarvis.updates.check();
  }

  function downloadUpdate(): void {
    window.jarvis.updates.download();
  }

  function installUpdate(): void {
    window.jarvis.updates.install();
  }

  async function toggleMemory(): Promise<void> {
    if (memoryEnabled === null || savingMemory) return;
    setSavingMemory(true);
    try {
      const result = await setMemoryEnabled(!memoryEnabled);
      setMemoryEnabledState(result.enabled);
    } finally {
      setSavingMemory(false);
    }
  }

  return (
    <div className="settings-view">
      <div className="settings-card glass-panel">
        <h2>Startup</h2>

        <div className="settings-row">
          <div>
            <p className="settings-row-title">Start JARVIS with Windows</p>
            <p className="settings-row-desc">
              Launches JARVIS automatically when you sign in to Windows, minimized to
              the system tray — no window pops up.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autostart ?? false}
            className={`toggle-switch${autostart ? " on" : ""}`}
            onClick={toggleAutostart}
            disabled={autostart === null || savingAutostart}
          >
            <span className="toggle-knob" />
          </button>
        </div>

        {autostart && (
          <p className="settings-note">
            Background mode is active for startup launches: while minimized to the
            tray, JARVIS keeps CPU and RAM usage minimal and just waits for your next
            command. Right-click the tray icon to reopen, activate, or quit at any
            time.
          </p>
        )}
      </div>

      <div className="settings-card glass-panel">
        <h2>Microphone</h2>

        <div className="settings-row">
          <div>
            <p className="settings-row-title">Allow microphone access</p>
            <p className="settings-row-desc">
              Off by default. Controls both the mic button here and "Activate
              Assistant" from the tray — no audio is captured while disabled.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={micEnabled ?? false}
            className={`toggle-switch${micEnabled ? " on" : ""}`}
            onClick={toggleMic}
            disabled={micEnabled === null || savingMic}
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <div className="settings-row">
          <div>
            <p className="settings-row-title">Wake word ("Hey Jarvis")</p>
            <p className="settings-row-desc">
              Off by default. When on, JARVIS listens continuously in the
              background for "Hey Jarvis" or just "Jarvis" and starts
              listening for your command automatically — no button press
              needed. Detection runs fully offline, on your own PC; audio is
              never sent anywhere unless it actually triggers a command.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={wakewordEnabled ?? false}
            className={`toggle-switch${wakewordEnabled ? " on" : ""}`}
            onClick={toggleWakeword}
            disabled={wakewordEnabled === null || savingWakeword}
          >
            <span className="toggle-knob" />
          </button>
        </div>
        {wakewordError && <p className="automation-error">{wakewordError}</p>}
      </div>

      <div className="settings-card glass-panel">
        <h2>Permissions</h2>

        <div className="settings-row">
          <div>
            <p className="settings-row-title">Allow JARVIS to control applications</p>
            <p className="settings-row-desc">
              Off by default. Lets the assistant open, switch to, or close any
              application actually installed on this PC, open common websites
              (YouTube, Netflix, Gmail, and more) or any web address, and open
              Windows Settings. Closing an app always asks you to confirm
              first, even with this on — nothing closes silently. Deleting
              files and changing system settings are never available.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={launchAppGranted ?? false}
            className={`toggle-switch${launchAppGranted ? " on" : ""}`}
            onClick={toggleLaunchAppPermission}
            disabled={launchAppGranted === null || savingPermission}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

      <div className="settings-card glass-panel">
        <h2>Files</h2>

        <div className="settings-row">
          <div>
            <p className="settings-row-title">Search files and folders</p>
            <p className="settings-row-desc">
              Off by default. Lets the assistant look for files and folders by
              name — your Desktop, Documents, Downloads, Pictures, Music, and
              Videos folders by default, or anywhere else on any drive if you
              name it (e.g. a drive letter or folder path). Read-only —
              nothing is moved, renamed, or created.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={fsReadGranted ?? false}
            className={`toggle-switch${fsReadGranted ? " on" : ""}`}
            onClick={toggleFsRead}
            disabled={fsReadGranted === null || savingFsRead}
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <div className="settings-row">
          <div>
            <p className="settings-row-title">Create, rename, and organize files</p>
            <p className="settings-row-desc">
              Off by default. Lets the assistant create folders, rename files,
              and sort a folder's loose files into type-based subfolders —
              anywhere on any drive, not just your personal folders.
              Organizing always previews the plan and asks you to confirm
              before moving anything. Deleting files is never available, with
              or without this on.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={fsWriteGranted ?? false}
            className={`toggle-switch${fsWriteGranted ? " on" : ""}`}
            onClick={toggleFsWrite}
            disabled={fsWriteGranted === null || savingFsWrite}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

      <div className="settings-card glass-panel">
        <h2>Memory</h2>

        <div className="settings-row">
          <div>
            <p className="settings-row-title">Remember things I tell you</p>
            <p className="settings-row-desc">
              On by default. When you say "Remember I use VS Code," JARVIS
              stores that and can use it later, e.g. "Open my editor." Turning
              this off stops new preferences and conversation history from
              being recorded, and stops existing ones from being used — it
              doesn't erase what's already remembered. View or delete what's
              remembered from the Memory page in the sidebar.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={memoryEnabled ?? false}
            className={`toggle-switch${memoryEnabled ? " on" : ""}`}
            onClick={toggleMemory}
            disabled={memoryEnabled === null || savingMemory}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

      <div className="settings-card glass-panel">
        <h2>Updates</h2>
        <div className="settings-row">
          <div>
            <p className="settings-row-title">JARVIS version {appVersion ?? "…"}</p>
            <p className="settings-row-desc">
              {updateStatus.state === "idle" && "Check for a newer version of JARVIS."}
              {updateStatus.state === "checking" && "Checking for updates…"}
              {updateStatus.state === "not-available" && "You're on the latest version."}
              {updateStatus.state === "available" && `Version ${updateStatus.version} is available.`}
              {updateStatus.state === "downloading" && `Downloading update… ${updateStatus.percent}%`}
              {updateStatus.state === "downloaded" &&
                `Version ${updateStatus.version} is ready — restart to finish installing.`}
              {updateStatus.state === "error" && updateStatus.message}
            </p>
          </div>
          {updateStatus.state === "downloaded" ? (
            <button type="button" className="automation-save" onClick={installUpdate}>
              Restart to update
            </button>
          ) : updateStatus.state === "available" ? (
            <button type="button" className="automation-save" onClick={downloadUpdate}>
              Download
            </button>
          ) : (
            <button
              type="button"
              className="automation-new-button"
              onClick={checkForUpdates}
              disabled={updateStatus.state === "checking" || updateStatus.state === "downloading"}
            >
              Check for updates
            </button>
          )}
        </div>
        {updateStatus.state === "downloading" && (
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${updateStatus.percent}%` }} />
          </div>
        )}
      </div>

      <div className="settings-card glass-panel">
        <h2>Recent activity</h2>
        <p className="settings-row-desc">
          A local record of actions JARVIS has actually taken — not requests or
          denials — so you can see exactly what it's done on your computer.
        </p>
        {recentActions === null ? (
          <p className="settings-row-desc">Nothing to show yet.</p>
        ) : recentActions.length === 0 ? (
          <p className="settings-row-desc">No actions recorded yet.</p>
        ) : (
          <ul className="memory-list">
            {recentActions.map((entry) => (
              <li key={entry.id} className="memory-item activity-item">
                <div className="memory-item-text activity-item-text">
                  <span className="memory-key">{entry.action.replace(/_/g, " ")}</span>
                  <span className="memory-value">{entry.result}</span>
                </div>
                <span className="activity-time">{formatActionTime(entry.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="settings-card glass-panel muted">
        <h2>More settings</h2>
        <p className="settings-row-desc">
          Voice engine choice and appearance options will live here later.
        </p>
      </div>
    </div>
  );
}
