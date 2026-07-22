import { useSystemStats } from "../hooks/useSystemStats";
import { CpuIcon, GpuIcon, RamIcon, StorageIcon, WifiIcon } from "./icons";

function Meter({
  icon,
  label,
  value,
  sub,
}: {
  icon: JSX.Element;
  label: string;
  value: number | null;
  sub?: string;
}): JSX.Element {
  const pct = value === null ? null : Math.round(value);
  return (
    <div className="meter">
      <div className="meter-header">
        <span className="meter-icon">{icon}</span>
        <span className="meter-label">{label}</span>
        <span className="meter-value">
          {pct === null ? "N/A" : `${pct}%`}
          {sub ? ` · ${sub}` : ""}
        </span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}

function formatSpeed(kbps: number): string {
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${kbps.toFixed(0)} KB/s`;
}

function formatGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

export default function SystemPanel(): JSX.Element {
  const stats = useSystemStats();

  const vramPercent =
    stats.gpuVramUsedMb !== null && stats.gpuVramTotalMb ? (stats.gpuVramUsedMb / stats.gpuVramTotalMb) * 100 : null;
  const vramSub =
    stats.gpuVramUsedMb !== null && stats.gpuVramTotalMb !== null
      ? `${formatGb(stats.gpuVramUsedMb)} / ${formatGb(stats.gpuVramTotalMb)}`
      : "N/A";

  return (
    <aside className="system-panel glass-panel">
      <h2>System</h2>

      <Meter
        icon={<CpuIcon />}
        label="CPU"
        value={stats.cpuPercent}
        sub={stats.cpuTempC !== null ? `${Math.round(stats.cpuTempC)}°C` : "temp N/A"}
      />
      <Meter
        icon={<GpuIcon />}
        label="GPU"
        value={stats.gpuPercent}
        sub={stats.gpuTempC !== null ? `${Math.round(stats.gpuTempC)}°C` : "temp N/A"}
      />
      <Meter icon={<GpuIcon />} label="VRAM" value={vramPercent} sub={vramSub} />
      <Meter icon={<RamIcon />} label="RAM" value={stats.ramPercent} />
      <Meter icon={<StorageIcon />} label="Storage" value={stats.storagePercent} />

      <div className="network-status">
        <span className="meter-icon">
          <WifiIcon />
        </span>
        <span className="meter-label">Network</span>
        <span className="network-speed-value">
          {"↓"} {formatSpeed(stats.downloadKbps)} {"·"} {"↑"} {formatSpeed(stats.uploadKbps)}
        </span>
      </div>
    </aside>
  );
}
