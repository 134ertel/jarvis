import { useEffect, useState } from "react";
import type { NavKey } from "../types/assistant";
import { useBackendStatus, type BackendStatus } from "../hooks/useBackendStatus";
import Sidebar from "./Sidebar";
import SystemPanel from "./SystemPanel";
import HomeView from "./HomeView";
import PlaceholderView from "./PlaceholderView";
import SettingsView from "./SettingsView";
import MemoryView from "./MemoryView";
import AutomationsView from "./AutomationsView";
import AiSettingsView from "./AiSettingsView";

const NAV_KEYS: NavKey[] = ["home", "conversations", "memory", "automations", "ai", "settings"];
function isNavKey(value: string): value is NavKey {
  return (NAV_KEYS as string[]).includes(value);
}

const PLACEHOLDER_COPY: Record<"conversations", { title: string; description: string }> = {
  conversations: {
    title: "Conversations",
    description: "Past conversations will be listed here once this view is connected.",
  },
};

function renderMain(active: NavKey, backendStatus: BackendStatus): JSX.Element {
  if (active === "home") return <HomeView backendStatus={backendStatus} />;
  if (active === "memory") return <MemoryView />;
  if (active === "automations") return <AutomationsView />;
  if (active === "ai") return <AiSettingsView />;
  if (active === "settings") return <SettingsView />;
  return <PlaceholderView {...PLACEHOLDER_COPY[active as "conversations"]} />;
}

export default function Layout(): JSX.Element {
  const [active, setActive] = useState<NavKey>("home");
  const backendStatus = useBackendStatus();

  // Lets the tray menu's "Settings" / "Activate Assistant" items drive navigation
  // from outside the window.
  useEffect(() => {
    return window.jarvis.onNavigate((view) => {
      if (isNavKey(view)) setActive(view);
    });
  }, []);

  return (
    <div className="app-shell">
      <Sidebar active={active} onSelect={setActive} backendStatus={backendStatus} />

      <main className="main-content">{renderMain(active, backendStatus)}</main>

      <SystemPanel />
    </div>
  );
}
