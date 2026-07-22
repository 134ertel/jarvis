import type { AIState } from "../types/assistant";

const STATE_COPY: Record<AIState, { label: string; detail: string }> = {
  connecting: { label: "CONNECTING", detail: "Reaching the JARVIS core..." },
  idle: { label: "IDLE", detail: "Awaiting your command" },
  listening: { label: "LISTENING", detail: "Go ahead, I'm listening..." },
  thinking: { label: "THINKING", detail: "Processing..." },
  speaking: { label: "SPEAKING", detail: "Responding..." },
};

export default function StatusDisplay({ state }: { state: AIState }): JSX.Element {
  const copy = STATE_COPY[state];
  return (
    <div className="status-display" data-state={state}>
      <span className="status-indicator" />
      <span className="status-label">{copy.label}</span>
      <span className="status-detail">{copy.detail}</span>
    </div>
  );
}
