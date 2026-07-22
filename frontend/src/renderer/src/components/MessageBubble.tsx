import type { ChatMessage } from "../types/assistant";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  return (
    <div className={`message-row ${message.role}`}>
      <div className="message-bubble">
        <p>{message.text}</p>
        <span className="message-time">{formatTime(message.timestamp)}</span>
      </div>
    </div>
  );
}
