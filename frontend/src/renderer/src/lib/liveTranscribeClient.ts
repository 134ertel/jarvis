/**
 * Live partial-transcript streaming while the user is actively speaking —
 * entirely separate from the authoritative /api/voice/converse call, which
 * alone decides the real transcript and reply (see shared/ipc-contract.md).
 * This connection streams small raw PCM frames to the backend's fast
 * rolling-transcription pass and receives back best-effort partial text.
 * Every method fails silently: if the connection never opens or drops,
 * partial captions simply stop updating — the real conversation flow
 * doesn't depend on this at all.
 */

const WS_URL = "ws://127.0.0.1:8756/ws/voice/live";

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

export class LiveTranscriber {
  private socket: WebSocket | null = null;

  connect(onPartial: (text: string) => void): void {
    try {
      const socket = new WebSocket(WS_URL);
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data?.event === "partial_transcript" && typeof data.text === "string") {
            onPartial(data.text);
          }
        } catch {
          // Ignore malformed frames.
        }
      };
      socket.onerror = () => {
        this.socket = null;
      };
      this.socket = socket;
    } catch {
      this.socket = null;
    }
  }

  sendFrame(frame: Float32Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const pcm16 = floatTo16BitPCM(frame);
    this.socket.send(pcm16.buffer);
  }

  endUtterance(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ event: "end_utterance" }));
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
  }
}
