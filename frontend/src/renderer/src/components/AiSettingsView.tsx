import { useEffect, useState } from "react";
import { getAiStatus, getAiModel, setAiModel, getAvailableModels } from "../lib/aiClient";
import { useBackendStatus } from "../hooks/useBackendStatus";

type ConnectionStatus = "loading" | "connected" | "disconnected";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  loading: "Loading…",
  connected: "Connected",
  disconnected: "Disconnected",
};

export default function AiSettingsView(): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>("loading");
  const [testing, setTesting] = useState(false);
  const [failed, setFailed] = useState(false);

  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const backendStatus = useBackendStatus();

  async function loadStatus(): Promise<void> {
    setStatus("loading");
    try {
      const result = await getAiStatus();
      setStatus(result.connected ? "connected" : "disconnected");
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  async function loadModels(): Promise<void> {
    setRefreshingModels(true);
    try {
      const result = await getAvailableModels();
      setAvailableModels(result.models);
      setModelsLoaded(true);
      setFailed(false);
    } catch {
      setAvailableModels([]);
      setModelsLoaded(false);
      setFailed(true);
    } finally {
      setRefreshingModels(false);
    }
  }

  async function loadCurrentModel(): Promise<void> {
    try {
      const result = await getAiModel();
      setCurrentModel(result.model);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  function loadAll(): void {
    loadStatus();
    loadCurrentModel();
    loadModels();
  }

  useEffect(() => {
    loadAll();
  }, []);

  // If the backend was unreachable when this page first loaded, or went down
  // mid-session, retry automatically once it's back online.
  useEffect(() => {
    if (backendStatus === "online" && failed) loadAll();
  }, [backendStatus]);

  async function testConnection(): Promise<void> {
    setTesting(true);
    setStatus("loading");
    try {
      const result = await getAiStatus();
      setStatus(result.connected ? "connected" : "disconnected");
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setTesting(false);
    }
  }

  async function refreshModels(): Promise<void> {
    await loadModels();
  }

  async function selectModel(model: string): Promise<void> {
    if (!model || model === currentModel || savingModel) return;
    setSavingModel(true);
    setModelError(null);
    try {
      const result = await setAiModel(model);
      setCurrentModel(result.model);
    } catch (err) {
      setModelError(err instanceof Error ? err.message : "Couldn't switch model.");
    } finally {
      setSavingModel(false);
    }
  }

  if (failed) {
    return (
      <div className="placeholder-view glass-panel">
        <div className="placeholder-ring" />
        <h2>AI</h2>
        <p>Couldn't reach the backend to load AI settings.</p>
      </div>
    );
  }

  // Always include the current model as a selectable option, even if it
  // isn't (or isn't yet) in Ollama's locally-pulled list — otherwise the
  // dropdown would silently show a different value than what's actually
  // configured.
  const modelOptions =
    currentModel && !availableModels.includes(currentModel) ? [currentModel, ...availableModels] : availableModels;

  return (
    <div className="ai-settings-view">
      <div className="settings-card glass-panel">
        <h2>AI Status</h2>
        <div className="settings-row">
          <div>
            <p className="settings-row-title">Local AI backend</p>
            <p className="settings-row-desc">
              {status === "loading" && "Checking whether Ollama is reachable…"}
              {status === "connected" &&
                "Connected — full natural-language understanding is active, running entirely on your own machine."}
              {status === "disconnected" &&
                "Disconnected. Install Ollama, pull a model, and make sure it's running — until then, JARVIS runs in fallback mode with simple pattern-matched replies only."}
            </p>
          </div>
          <span
            className={`network-pill${
              status === "connected" ? " online" : status === "loading" ? " loading" : " offline"
            }`}
          >
            {STATUS_LABEL[status]}
          </span>
        </div>
        <div className="settings-row">
          <button type="button" className="automation-new-button" onClick={testConnection} disabled={testing}>
            {testing ? "Testing…" : "Test connection"}
          </button>
        </div>
      </div>

      <div className="settings-card glass-panel">
        <h2>Model</h2>
        <div className="settings-row">
          <div>
            <p className="settings-row-title">Active model</p>
            <p className="settings-row-desc">
              Which model Ollama uses for full understanding — switching here takes effect on your
              very next message, no restart needed. Options are loaded directly from Ollama's own
              list of locally-pulled models.
            </p>
          </div>
        </div>
        <div className="settings-row">
          <select
            className="settings-select"
            value={currentModel ?? ""}
            onChange={(e) => selectModel(e.target.value)}
            disabled={savingModel || modelOptions.length === 0}
          >
            {modelOptions.length === 0 && <option value="">No models found</option>}
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="automation-new-button"
            onClick={refreshModels}
            disabled={refreshingModels}
          >
            {refreshingModels ? "Refreshing…" : "Refresh installed models"}
          </button>
        </div>
        {modelsLoaded && availableModels.length === 0 && (
          <p className="settings-note">
            Ollama didn't report any locally-pulled models — pull one with Ollama, then refresh.
          </p>
        )}
        {savingModel && <p className="settings-row-desc">Switching model…</p>}
        {modelError && <p className="automation-error">{modelError}</p>}
      </div>
    </div>
  );
}
