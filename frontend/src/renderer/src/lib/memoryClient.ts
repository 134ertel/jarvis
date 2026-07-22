/**
 * Client for the backend's memory REST endpoints (see shared/ipc-contract.md).
 */

const BACKEND_URL = "http://127.0.0.1:8756";

export interface Fact {
  key: string;
  value: string;
}

export async function getMemoryEnabled(): Promise<{ enabled: boolean }> {
  const res = await fetch(`${BACKEND_URL}/api/memory/enabled`);
  if (!res.ok) throw new Error(`memory enabled fetch failed: ${res.status}`);
  return res.json();
}

export async function setMemoryEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
  const res = await fetch(`${BACKEND_URL}/api/memory/enabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`set memory enabled failed: ${res.status}`);
  return res.json();
}

export async function getFacts(): Promise<{ facts: Fact[] }> {
  const res = await fetch(`${BACKEND_URL}/api/memory/facts`);
  if (!res.ok) throw new Error(`facts fetch failed: ${res.status}`);
  return res.json();
}

export async function deleteFact(key: string): Promise<{ key: string; deleted: boolean }> {
  const res = await fetch(`${BACKEND_URL}/api/memory/facts/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete fact failed: ${res.status}`);
  return res.json();
}
