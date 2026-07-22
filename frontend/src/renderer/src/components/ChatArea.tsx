import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types/assistant";
import MessageBubble from "./MessageBubble";

interface ChatAreaProps {
  messages: ChatMessage[];
  /** Best-effort live caption of what the user is currently saying, shown as
   * a provisional bubble while voice mode is actively hearing speech — never
   * added to `messages`, just replaced by the real transcript once it
   * arrives (or cleared if nothing came of it). */
  livePartialText?: string | null;
}

export default function ChatArea({ messages, livePartialText }: ChatAreaProps): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, livePartialText]);

  return (
    <div className="chat-area glass-panel">
      <div className="chat-scroll">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {livePartialText && (
          <div className="message-row user live">
            <div className="message-bubble">
              <p>{livePartialText}</p>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
