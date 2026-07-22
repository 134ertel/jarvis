import { useCallback, useEffect, useRef, useState } from "react";
import { startVAD, encodeWavFromFloat32, type VoiceActivityDetector } from "../lib/vad";
import { LiveTranscriber } from "../lib/liveTranscribeClient";
import { playBase64WavControllable } from "../lib/voiceClient";
import { resumeWakewordListening } from "../lib/wakewordClient";

interface UseVoiceConversationOptions {
  /** Called with a finished utterance's WAV blob. Should resolve once JARVIS
   * has finished responding (spoken reply played, or decided not to) —
   * listening resumes automatically right after, as long as voice mode is
   * still active. */
  onUtterance: (wavBlob: Blob) => Promise<void>;
  /** Checked before every start (mic permission etc.) — voice mode never
   * begins if this resolves false. */
  canListen: () => Promise<boolean>;
  onSpeechStart?: () => void;
  /** Best-effort live caption text while actively speaking — cleared by the
   * caller once the authoritative transcript arrives via onUtterance. */
  onPartialTranscript?: (text: string) => void;
  /** Raw mic frames (~32ms each) for as long as voice mode is listening and
   * JARVIS isn't the one talking — feeds the orb's audio-reactivity (see
   * useAudioLevel.ts), not gated to only-while-speech-detected so idle
   * listening still shows some ambient movement. */
  onMicFrame?: (frame: Float32Array) => void;
  /** Called with the Audio element the instant a reply starts playing, so
   * the caller can tap its real waveform for orb reactivity. The returned
   * cleanup (if any) is called once that same playback ends. */
  onPlaybackStart?: (audio: HTMLAudioElement) => (() => void) | void;
  onError?: (message: string) => void;
}

export interface VoiceConversation {
  voiceModeActive: boolean;
  toggleVoiceMode: () => void;
  /** Starts voice mode the way a wake-word detection does — always begins
   * (never toggles off), and marks this session so mutual silence auto-exits
   * it and tells the backend to resume wake-word listening afterward. Manual
   * voice mode (toggleVoiceMode) never auto-exits on silence, per spec —
   * only wake-triggered sessions do. */
  startFromWakeWord: () => void;
  /** Plays a reply's audio while voice mode is active, watching for the user
   * barging in (talking over it) — if they do, playback stops immediately
   * and this resolves right away instead of waiting for natural playback
   * end. Only meaningful mid-utterance-processing (see onUtterance); not
   * used for the typed-message path, which has no active VAD stream to
   * detect a barge-in with. */
  speakWithBargeIn: (audioBase64: string) => Promise<void>;
}

// After a wake-triggered conversation goes quiet (no user speech, no JARVIS
// reply) for this long, automatically leave voice mode and let the backend
// resume reacting to the wake phrase. Manual (button-pressed) voice mode
// never uses this — it stays on until the user presses the mic again,
// per spec.
const SILENCE_TIMEOUT_MS = 7000;

/**
 * Owns the continuous "press mic once, keep talking, no more button presses"
 * loop: starts a VAD-driven mic listener, hands each detected utterance to
 * `onUtterance`, and — once that resolves — resumes listening automatically
 * if voice mode is still on. Toggling voice mode off (pressing mic again)
 * tears the listener down entirely and releases the microphone.
 *
 * Also streams raw audio frames to a live-partial-transcription pass (see
 * lib/liveTranscribeClient.ts) for the whole span between onSpeechStart and
 * onSpeechEnd/onVADMisfire — not continuously — so live captions only ever
 * cover actual speech, not the silence in between utterances, and never
 * cover JARVIS's own voice (frame-forwarding is suppressed while
 * speakWithBargeIn has an active playback — see jarvisSpeakingRef below).
 *
 * Interruption/barge-in: VAD is normally paused during "thinking" (the
 * network round-trip) exactly like before, but speakWithBargeIn resumes it
 * right before starting playback and races the audio against
 * onSpeechRealStart — a real, sustained speech-start, not just a blip. If
 * the user talks over JARVIS, playback is cut immediately; VAD was already
 * mid-capturing that interrupting utterance the whole time, so it flows
 * through the exact same onSpeechEnd -> onUtterance path as any normal turn
 * once they finish talking — no special-case "restart capture" needed.
 *
 * Wake-word sessions (startFromWakeWord): identical listening/barge-in
 * machinery, plus a silence watchdog that auto-exits voice mode and tells
 * the backend to resume wake-word listening (see wakewordClient.ts) once
 * both sides have been quiet for SILENCE_TIMEOUT_MS — the backend paused
 * wake-word detection the instant it fired, specifically so the resume call
 * here is what lets the same phrase work again for the *next* conversation.
 *
 * Orb audio-reactivity (see useAudioLevel.ts): onMicFrame forwards raw
 * frames while listening (and JARVIS isn't the one talking), onPlaybackStart
 * hands over the reply's Audio element the instant it starts playing — both
 * are just thin pass-throughs, this hook has no opinion on what the caller
 * does with them.
 *
 * Uses refs (not just React state) for anything read inside async
 * VAD callbacks, which can fire well after a render and must never act on
 * stale closures.
 */
export function useVoiceConversation(options: UseVoiceConversationOptions): VoiceConversation {
  const [voiceModeActive, setVoiceModeActive] = useState(false);
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  const liveTranscriberRef = useRef<LiveTranscriber | null>(null);
  const userSpeakingRef = useRef(false);
  const jarvisSpeakingRef = useRef(false);
  const bargeInRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(false);
  const processingRef = useRef(false);
  const isWakeSessionRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const stopVoice = useCallback(async () => {
    activeRef.current = false;
    setVoiceModeActive(false);
    clearSilenceTimer();
    const wasWakeSession = isWakeSessionRef.current;
    isWakeSessionRef.current = false;
    const vad = vadRef.current;
    vadRef.current = null;
    liveTranscriberRef.current?.disconnect();
    liveTranscriberRef.current = null;
    if (vad) await vad.destroy();
    // Only a wake-triggered session paused the backend's wake-word listener
    // in the first place — a manual session never touched it, so it's never
    // meaningful to resume there.
    if (wasWakeSession) void resumeWakewordListening();
  }, [clearSilenceTimer]);

  const resetSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    if (!isWakeSessionRef.current) return;
    silenceTimerRef.current = setTimeout(() => {
      void stopVoice();
    }, SILENCE_TIMEOUT_MS);
  }, [clearSilenceTimer, stopVoice]);

  const speakWithBargeIn = useCallback(async (audioBase64: string): Promise<void> => {
    clearSilenceTimer();
    // Resume listening (paused since the utterance that led to this reply)
    // so VAD can actually detect a barge-in during playback.
    if (activeRef.current && vadRef.current) {
      try {
        await vadRef.current.start();
      } catch {
        // If the mic can't be reacquired, playback still proceeds — just
        // without barge-in support for this one reply.
      }
    }

    const playback = playBase64WavControllable(audioBase64);
    jarvisSpeakingRef.current = true;
    const stopPlaybackLevel = optionsRef.current.onPlaybackStart?.(playback.audio);

    const bargeInPromise = new Promise<void>((resolve) => {
      bargeInRef.current = () => {
        playback.stop();
        resolve();
      };
    });

    try {
      await Promise.race([playback.done, bargeInPromise]);
    } finally {
      jarvisSpeakingRef.current = false;
      bargeInRef.current = null;
      stopPlaybackLevel?.();
    }
  }, [clearSilenceTimer]);

  const handleSpeechEnd = useCallback(async (audio: Float32Array) => {
    userSpeakingRef.current = false;
    liveTranscriberRef.current?.endUtterance();
    if (!activeRef.current || processingRef.current) return;
    processingRef.current = true;
    clearSilenceTimer();
    try {
      await vadRef.current?.pause();
      const wavBlob = encodeWavFromFloat32(audio);
      await optionsRef.current.onUtterance(wavBlob);
    } finally {
      processingRef.current = false;
      if (activeRef.current && vadRef.current) {
        try {
          await vadRef.current.start();
          resetSilenceTimer();
        } catch {
          optionsRef.current.onError?.("Lost microphone access while resuming voice mode.");
          await stopVoice();
        }
      }
    }
  }, [clearSilenceTimer, resetSilenceTimer, stopVoice]);

  const beginListening = useCallback(async (isWakeSession: boolean): Promise<void> => {
    const allowed = await optionsRef.current.canListen();
    if (!allowed) return;
    activeRef.current = true;
    isWakeSessionRef.current = isWakeSession;
    setVoiceModeActive(true);

    const liveTranscriber = new LiveTranscriber();
    liveTranscriber.connect((text) => optionsRef.current.onPartialTranscript?.(text));
    liveTranscriberRef.current = liveTranscriber;

    try {
      vadRef.current = await startVAD({
        onSpeechStart: () => {
          // A blip while JARVIS is speaking shouldn't show a "you're saying
          // this" caption for JARVIS's own bled-through voice.
          if (jarvisSpeakingRef.current) return;
          userSpeakingRef.current = true;
          clearSilenceTimer();
          optionsRef.current.onSpeechStart?.();
        },
        onSpeechRealStart: () => {
          if (jarvisSpeakingRef.current) bargeInRef.current?.();
        },
        onSpeechEnd: (audio) => void handleSpeechEnd(audio),
        onVADMisfire: () => {
          userSpeakingRef.current = false;
          liveTranscriberRef.current?.endUtterance();
          resetSilenceTimer();
        },
        onFrameProcessed: (frame) => {
          if (jarvisSpeakingRef.current) return;
          if (userSpeakingRef.current) liveTranscriberRef.current?.sendFrame(frame);
          optionsRef.current.onMicFrame?.(frame);
        },
      });
      resetSilenceTimer();
    } catch {
      optionsRef.current.onError?.(
        "I couldn't access the microphone. Check Windows' microphone privacy settings for JARVIS."
      );
      activeRef.current = false;
      isWakeSessionRef.current = false;
      setVoiceModeActive(false);
      liveTranscriberRef.current?.disconnect();
      liveTranscriberRef.current = null;
    }
  }, [clearSilenceTimer, handleSpeechEnd, resetSilenceTimer]);

  const toggleVoiceMode = useCallback(() => {
    if (activeRef.current) {
      void stopVoice();
    } else {
      void beginListening(false);
    }
  }, [beginListening, stopVoice]);

  const startFromWakeWord = useCallback(() => {
    // The backend already paused wake-word detection the instant it fired,
    // so this shouldn't ever race an already-active session — but never
    // stomp on one just in case.
    if (activeRef.current) return;
    void beginListening(true);
  }, [beginListening]);

  // Release the mic/socket if the component using this hook unmounts
  // mid-session (e.g. navigating away from Home) rather than leaking them.
  useEffect(() => {
    return () => {
      clearSilenceTimer();
      void vadRef.current?.destroy();
      liveTranscriberRef.current?.disconnect();
    };
  }, [clearSilenceTimer]);

  return { voiceModeActive, toggleVoiceMode, startFromWakeWord, speakWithBargeIn };
}
