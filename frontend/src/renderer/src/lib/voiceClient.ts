/**
 * Client for the backend's voice/AI REST endpoints (see shared/ipc-contract.md).
 * Loopback-only, fully local — speech-to-text runs offline via faster-whisper
 * (see backend/app/voice/stt.py), nothing is sent anywhere.
 */

const BACKEND_URL = "http://127.0.0.1:8756";

export interface PendingConfirmation {
  kind: string;
  prompt: string;
}

export interface ConverseResult {
  transcript: string;
  reply: string;
  audioBase64: string;
  confirmation: PendingConfirmation | null;
}

export interface RespondResult {
  reply: string;
  audioBase64: string;
  confirmation: PendingConfirmation | null;
}

export async function converse(wavBlob: Blob): Promise<ConverseResult> {
  const res = await fetch(`${BACKEND_URL}/api/voice/converse`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wavBlob,
  });
  if (!res.ok) throw new Error(`voice converse failed: ${res.status}`);
  const data = await res.json();
  return {
    transcript: data.transcript,
    reply: data.reply,
    audioBase64: data.audio_base64,
    confirmation: data.confirmation ?? null,
  };
}

/** Speech synthesis only, no AI involved — used for fixed acknowledgment
 * phrases (e.g. the "Yes?" said right after a wake-word detection) that
 * need real spoken audio but aren't a conversational reply. */
export async function synthesizeSpeech(text: string): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/api/voice/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`synthesize failed: ${res.status}`);
  const data = await res.json();
  return data.audio_base64;
}

export async function respondToText(text: string): Promise<RespondResult> {
  const res = await fetch(`${BACKEND_URL}/api/ai/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`respond failed: ${res.status}`);
  const data = await res.json();
  return { reply: data.reply, audioBase64: data.audio_base64, confirmation: data.confirmation ?? null };
}

export function playBase64Wav(base64: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(`data:audio/wav;base64,${base64}`);
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("audio playback failed"));
    audio.play().catch(reject);
  });
}

export interface PlaybackHandle {
  audio: HTMLAudioElement;
  /** Resolves when playback finishes naturally OR is stopped early via `stop()` —
   * either way this always resolves (never rejects) so a caller racing it
   * against a barge-in signal doesn't need a separate error path. */
  done: Promise<void>;
  stop: () => void;
}

/** Same as playBase64Wav, but returns a handle that can stop playback early —
 * used for voice mode's interruption/barge-in support (see
 * useVoiceConversation.ts), where "JARVIS immediately stops talking" needs a
 * real way to cut audio off mid-sentence. */
export function playBase64WavControllable(base64: string): PlaybackHandle {
  const audio = new Audio(`data:audio/wav;base64,${base64}`);
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  audio.onended = () => settle();
  audio.onerror = () => settle();
  audio.play().catch(() => settle());

  return {
    audio,
    done,
    stop: () => {
      audio.pause();
      settle();
    },
  };
}
