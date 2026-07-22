/**
 * Client for the backend's AI-status and security-permission REST endpoints
 * (see shared/ipc-contract.md). Separate from voiceClient.ts since these cover
 * different backend modules (app.ai / app.security), even though both are
 * reached over the same loopback HTTP server.
 */

const BACKEND_URL = "http://127.0.0.1:8756";

export async function getAiStatus(): Promise<{ connected: boolean }> {
  const res = await fetch(`${BACKEND_URL}/api/ai/status`);
  if (!res.ok) throw new Error(`ai status failed: ${res.status}`);
  return res.json();
}

export async function getAiModel(): Promise<{ model: string }> {
  const res = await fetch(`${BACKEND_URL}/api/ai/model`);
  if (!res.ok) throw new Error(`ai model fetch failed: ${res.status}`);
  return res.json();
}

export async function setAiModel(model: string): Promise<{ model: string }> {
  const res = await fetch(`${BACKEND_URL}/api/ai/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((body: { detail?: string }) => body.detail)
      .catch(() => undefined);
    throw new Error(detail ?? `set ai model failed: ${res.status}`);
  }
  return res.json();
}

export async function getAvailableModels(): Promise<{ models: string[] }> {
  const res = await fetch(`${BACKEND_URL}/api/ai/models`);
  if (!res.ok) throw new Error(`available models fetch failed: ${res.status}`);
  return res.json();
}

export async function getPermissions(): Promise<Record<string, boolean>> {
  const res = await fetch(`${BACKEND_URL}/api/security/permissions`);
  if (!res.ok) throw new Error(`permissions fetch failed: ${res.status}`);
  return res.json();
}

export async function setPermission(scope: string, granted: boolean): Promise<{ scope: string; granted: boolean }> {
  const res = await fetch(`${BACKEND_URL}/api/security/permissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, granted }),
  });
  if (!res.ok) throw new Error(`set permission failed: ${res.status}`);
  return res.json();
}
