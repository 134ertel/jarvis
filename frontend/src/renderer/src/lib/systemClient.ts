/**
 * Client for the backend's real hardware telemetry endpoint — see
 * app.control.system.get_telemetry. Fields the current hardware/OS can't
 * genuinely provide (e.g. no exposed CPU thermal zone, no NVIDIA GPU) come
 * back as null, never a fabricated number.
 */

const BACKEND_URL = "http://127.0.0.1:8756";

export interface TelemetryResponse {
  cpu_percent: number;
  cpu_temp_c: number | null;
  gpu_name: string | null;
  gpu_percent: number | null;
  gpu_temp_c: number | null;
  gpu_vram_used_mb: number | null;
  gpu_vram_total_mb: number | null;
  ram_percent: number;
  storage_percent: number;
  download_kbps: number;
  upload_kbps: number;
  network_up: boolean;
}

export async function getTelemetry(): Promise<TelemetryResponse> {
  const res = await fetch(`${BACKEND_URL}/api/system/telemetry`);
  if (!res.ok) throw new Error(`telemetry fetch failed: ${res.status}`);
  return res.json();
}
