/**
 * Client for the backend's automation/routines REST endpoints (see
 * shared/ipc-contract.md).
 */

const BACKEND_URL = "http://127.0.0.1:8756";

export type StepType = "open_app" | "switch_window" | "open_settings" | "open_folder" | "check_performance";

export interface Step {
  type: StepType;
  target: string;
}

export interface Routine {
  id: string;
  name: string;
  steps: Step[];
}

async function readError(res: Response, fallback: string): Promise<never> {
  const detail = await res
    .json()
    .then((body: { detail?: string }) => body.detail)
    .catch(() => undefined);
  throw new Error(detail ?? fallback);
}

export async function getAutomationOptions(): Promise<{ apps: string[]; folders: string[] }> {
  const res = await fetch(`${BACKEND_URL}/api/automations/options`);
  if (!res.ok) throw new Error(`automation options fetch failed: ${res.status}`);
  return res.json();
}

export async function getRoutines(): Promise<{ routines: Routine[] }> {
  const res = await fetch(`${BACKEND_URL}/api/automations`);
  if (!res.ok) throw new Error(`routines fetch failed: ${res.status}`);
  return res.json();
}

export async function createRoutine(name: string, steps: Step[]): Promise<{ routine: Routine }> {
  const res = await fetch(`${BACKEND_URL}/api/automations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, steps }),
  });
  if (!res.ok) return readError(res, `create routine failed: ${res.status}`);
  return res.json();
}

export async function updateRoutine(id: string, name: string, steps: Step[]): Promise<{ routine: Routine }> {
  const res = await fetch(`${BACKEND_URL}/api/automations/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, steps }),
  });
  if (!res.ok) return readError(res, `update routine failed: ${res.status}`);
  return res.json();
}

export async function deleteRoutine(id: string): Promise<{ id: string; deleted: boolean }> {
  const res = await fetch(`${BACKEND_URL}/api/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete routine failed: ${res.status}`);
  return res.json();
}

export async function requestRunRoutine(id: string): Promise<{ reply: string }> {
  const res = await fetch(`${BACKEND_URL}/api/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
  if (!res.ok) return readError(res, `run routine failed: ${res.status}`);
  return res.json();
}

export async function confirmPendingRun(answer: "yes" | "no"): Promise<{ reply: string }> {
  const res = await fetch(`${BACKEND_URL}/api/ai/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: answer }),
  });
  if (!res.ok) throw new Error(`confirm run failed: ${res.status}`);
  return res.json();
}
