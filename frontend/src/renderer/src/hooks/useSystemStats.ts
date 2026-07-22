import { useEffect, useState } from "react";
import { getTelemetry } from "../lib/systemClient";
import type { SystemStats } from "../types/assistant";

const EMPTY_STATS: SystemStats = {
  cpuPercent: 0,
  cpuTempC: null,
  gpuName: null,
  gpuPercent: null,
  gpuTempC: null,
  gpuVramUsedMb: null,
  gpuVramTotalMb: null,
  ramPercent: 0,
  storagePercent: 0,
  downloadKbps: 0,
  uploadKbps: 0,
  networkUp: false,
};

/**
 * Real hardware telemetry, polled roughly every second. The backend's
 * request itself blocks for ~1s (it samples CPU/network over a genuine
 * 1-second window), so the next poll is only scheduled once the current one
 * resolves — a recursive setTimeout, not setInterval, so a slow or hung
 * request can't stack up parallel calls.
 */
export function useSystemStats(): SystemStats {
  const [stats, setStats] = useState<SystemStats>(EMPTY_STATS);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      let nextDelay = 1500;
      try {
        const t = await getTelemetry();
        if (!cancelled) {
          setStats({
            cpuPercent: t.cpu_percent,
            cpuTempC: t.cpu_temp_c,
            gpuName: t.gpu_name,
            gpuPercent: t.gpu_percent,
            gpuTempC: t.gpu_temp_c,
            gpuVramUsedMb: t.gpu_vram_used_mb,
            gpuVramTotalMb: t.gpu_vram_total_mb,
            ramPercent: t.ram_percent,
            storagePercent: t.storage_percent,
            downloadKbps: t.download_kbps,
            uploadKbps: t.upload_kbps,
            networkUp: t.network_up,
          });
          nextDelay = 50;
        }
      } catch {
        // Backend unreachable this tick — keep showing the last known
        // values rather than resetting to zero/N/A, then back off briefly
        // before retrying.
      } finally {
        if (!cancelled) timer = setTimeout(poll, nextDelay);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return stats;
}
