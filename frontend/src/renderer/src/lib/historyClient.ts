/**
 * Client for the backend's read-only action-history endpoint (see
 * shared/ipc-contract.md). Actions actually executed, not requested or
 * denied — used by the Settings page's "Recent activity" card.
 */

const BACKEND_URL = "http://127.0.0.1:8756";

export interface ActionEntry {
  id: string;
  timestamp: string;
  action: string;
  detail: string;
  result: string;
}

export async function getRecentActions(limit = 20): Promise<{ actions: ActionEntry[] }> {
  const res = await fetch(`${BACKEND_URL}/api/history/actions?limit=${limit}`);
  if (!res.ok) throw new Error(`action history fetch failed: ${res.status}`);
  return res.json();
}
