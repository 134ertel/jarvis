import { useState, type FormEvent } from "react";
import type { AIState } from "../types/assistant";
import { MicIcon, SendIcon } from "./icons";

interface ComposerProps {
  state: AIState;
  disabled: boolean;
  onSend: (text: string) => void;
  onMicPress: () => void;
}

export default function Composer({ state, disabled, onSend, onMicPress }: ComposerProps): JSX.Element {
  const [text, setText] = useState("");

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <form className="composer glass-panel" onSubmit={handleSubmit}>
      <button
        type="button"
        className={`mic-button${state === "listening" ? " active" : ""}`}
        onClick={onMicPress}
        disabled={disabled && state !== "listening"}
        aria-label="Toggle microphone"
      >
        <MicIcon />
        {state === "listening" && <span className="mic-pulse" />}
      </button>

      <input
        type="text"
        placeholder={state === "listening" ? "Listening..." : "Type a message..."}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
      />

      <button type="submit" className="send-button" disabled={disabled || !text.trim()} aria-label="Send message">
        <SendIcon />
      </button>
    </form>
  );
}
