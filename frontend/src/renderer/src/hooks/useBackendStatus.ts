import { useEffect, useState } from "react";

export type BackendStatus = "starting" | "online" | "offline" | "crashed";

const VALID_STATUSES: BackendStatus[] = ["starting", "online", "offline", "crashed"];

function isBackendStatus(value: string): value is BackendStatus {
  return (VALID_STATUSES as string[]).includes(value);
}

/**
 * Real backend health, not a one-time check — reflects crashes/recoveries
 * mid-session too. Seeds from the *current* status on mount (getBackendStatus)
 * rather than only ever future push events (onBackendStatus) — this matters
 * because this hook is used by views that mount well after the window's
 * initial load (Settings, Automations, Memory, opened later via sidebar
 * navigation), which would otherwise never learn a status that already
 * settled before they existed.
 */
export function useBackendStatus(): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>("starting");

  useEffect(() => {
    let cancelled = false;
    window.jarvis.getBackendStatus().then((current) => {
      if (!cancelled && isBackendStatus(current)) setStatus(current);
    });
    const unsubscribe = window.jarvis.onBackendStatus((next) => {
      if (isBackendStatus(next)) setStatus(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return status;
}
