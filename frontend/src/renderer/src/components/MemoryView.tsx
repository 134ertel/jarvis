import { useEffect, useState } from "react";
import { deleteFact, getFacts, getMemoryEnabled, type Fact } from "../lib/memoryClient";
import { useBackendStatus } from "../hooks/useBackendStatus";

export default function MemoryView(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [failed, setFailed] = useState(false);
  const backendStatus = useBackendStatus();

  async function refresh(): Promise<void> {
    try {
      const [status, list] = await Promise.all([getMemoryEnabled(), getFacts()]);
      setEnabled(status.enabled);
      setFacts(list.facts);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // If the backend was unreachable when this view first loaded (or crashed
  // mid-session), retry automatically once it's back online instead of
  // leaving the "couldn't reach backend" placeholder up until the user
  // happens to navigate away and back.
  useEffect(() => {
    if (backendStatus === "online" && failed) refresh();
  }, [backendStatus]);

  async function handleDelete(key: string): Promise<void> {
    await deleteFact(key);
    refresh();
  }

  if (failed) {
    return (
      <div className="placeholder-view glass-panel">
        <div className="placeholder-ring" />
        <h2>Memory</h2>
        <p>Couldn't reach the backend to load memories.</p>
      </div>
    );
  }

  return (
    <div className="memory-view">
      <div className="settings-card glass-panel">
        <h2>Memory</h2>
        <p className="settings-row-desc">
          {enabled === false
            ? "Memory is currently off in Settings — JARVIS won't learn new preferences until you turn it back on. Anything remembered from before is still listed below."
            : 'Preferences JARVIS has been explicitly told to remember, like "Remember I use VS Code." Say "what do you remember?" to hear them, or delete any of them below.'}
        </p>
      </div>

      <div className="settings-card glass-panel">
        {facts === null ? (
          <p className="settings-row-desc">Loading…</p>
        ) : facts.length === 0 ? (
          <p className="settings-row-desc">
            Nothing remembered yet. Try saying "Remember I use VS Code," then later "Open my editor."
          </p>
        ) : (
          <ul className="memory-list">
            {facts.map((fact) => (
              <li key={fact.key} className="memory-item">
                <div className="memory-item-text">
                  <span className="memory-key">{fact.key}</span>
                  <span className="memory-value">{fact.value}</span>
                </div>
                <button type="button" className="memory-delete" onClick={() => handleDelete(fact.key)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
