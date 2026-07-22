/**
 * Thin wrapper around @ricky0123/vad-web's MicVAD (Silero VAD v5, ONNX,
 * running in an AudioWorklet) — real voice-activity detection instead of a
 * hand-rolled energy threshold, so natural mid-sentence pauses don't cut a
 * recording off early. Model/worklet/onnxruntime-web WASM assets are
 * self-hosted in src/renderer/public (see that folder) — no CDN fetch,
 * matching this project's fully-local approach everywhere else.
 *
 * MicVAD's own onSpeechEnd hands back the complete utterance as a Float32Array
 * (16kHz, already includes pre-speech padding) — no manual chunk accumulation
 * needed, unlike the old push-to-talk recorder this replaces.
 */

import { MicVAD, utils } from "@ricky0123/vad-web";

export interface VoiceActivityDetector {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
}

export interface VadCallbacks {
  onSpeechStart?: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onVADMisfire?: () => void;
  /** Fires once a detected speech segment has persisted long enough that VAD
   * is confident it's real (i.e. it won't retroactively turn into an
   * onVADMisfire) — a more reliable "the user is genuinely talking" signal
   * than onSpeechStart, which can fire on a blip that never pans out. Used
   * as the barge-in trigger while JARVIS is speaking (see
   * useVoiceConversation.ts) specifically because it's already gated against
   * noise/false starts. */
  onSpeechRealStart?: () => void;
  /** Fired after every processed frame (~32ms at 16kHz), speech or not —
   * used to stream audio to the live-partial-transcript pipeline while
   * actual speech is in progress (see useVoiceConversation). */
  onFrameProcessed?: (frame: Float32Array) => void;
}

// Silero's own convention: keep the negative threshold ~0.15 below the
// positive one.
const POSITIVE_SPEECH_THRESHOLD = 0.5;
const NEGATIVE_SPEECH_THRESHOLD = 0.35;

// How long a stretch of low-speech-probability audio must persist before an
// utterance is considered finished — the "tolerate natural pauses" knob.
// Silero's own default (400ms) cuts off natural mid-sentence breathing pauses
// too eagerly for a ChatGPT-Voice-Mode-style conversation; this is deliberately
// longer, and is meant to become a user-tunable Settings value later (see the
// project plan's Phase 9), not a permanent hardcoded constant.
export const DEFAULT_REDEMPTION_MS = 800;

export async function startVAD(
  callbacks: VadCallbacks,
  redemptionMs: number = DEFAULT_REDEMPTION_MS
): Promise<VoiceActivityDetector> {
  const vad = await MicVAD.new({
    model: "v5",
    baseAssetPath: "/",
    onnxWASMBasePath: "/",
    positiveSpeechThreshold: POSITIVE_SPEECH_THRESHOLD,
    negativeSpeechThreshold: NEGATIVE_SPEECH_THRESHOLD,
    redemptionMs,
    onSpeechStart: () => callbacks.onSpeechStart?.(),
    onSpeechEnd: (audio) => callbacks.onSpeechEnd(audio),
    onVADMisfire: () => callbacks.onVADMisfire?.(),
    onSpeechRealStart: () => callbacks.onSpeechRealStart?.(),
    onFrameProcessed: (_probabilities, frame) => callbacks.onFrameProcessed?.(frame),
  });

  return {
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: () => vad.destroy(),
  };
}

/** 16-bit PCM WAV, matching wavRecorder.ts's format and what the backend's
 * speech-to-text already expects — vad-web's own encodeWAV defaults to
 * 32-bit float, so the format/bitDepth are passed explicitly here. */
export function encodeWavFromFloat32(samples: Float32Array): Blob {
  const buffer = utils.encodeWAV(samples, 1, 16000, 1, 16);
  return new Blob([buffer], { type: "audio/wav" });
}
