import type { NavKey } from "../types/assistant";
import type { BackendStatus } from "../hooks/useBackendStatus";
import {
  HomeIcon,
  ChatIcon,
  MemoryIcon,
  AutomationIcon,
  AiIcon,
  SettingsIcon,
} from "./icons";

const NAV_ITEMS: { key: NavKey; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { key: "home", label: "Home", icon: HomeIcon },
  { key: "conversations", label: "Conversations", icon: ChatIcon },
  { key: "memory", label: "Memory", icon: MemoryIcon },
  { key: "automations", label: "Automations", icon: AutomationIcon },
  { key: "ai", label: "AI", icon: AiIcon },
  { key: "settings", label: "Settings", icon: SettingsIcon },
];

const STATUS_COPY: Record<BackendStatus, string> = {
  starting: "Connecting…",
  online: "Backend online",
  offline: "Reconnecting…",
  crashed: "Backend unavailable",
};

interface SidebarProps {
  active: NavKey;
  onSelect: (key: NavKey) => void;
  backendStatus: BackendStatus;
}

export default function Sidebar({ active, onSelect, backendStatus }: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar glass-panel">
      <div className="sidebar-brand">
        <span className="brand-mark" />
        <span className="brand-text">JARVIS</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`sidebar-item${active === key ? " active" : ""}`}
            onClick={() => onSelect(key)}
            type="button"
          >
            <span className="sidebar-icon">
              <Icon />
            </span>
            <span className="sidebar-label">{label}</span>
            {active === key && <span className="sidebar-active-glow" />}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <span className={`status-dot ${backendStatus === "online" ? "online" : backendStatus === "crashed" ? "crashed" : "offline"}`} />
        <span>{STATUS_COPY[backendStatus]}</span>
      </div>
    </aside>
  );
}
