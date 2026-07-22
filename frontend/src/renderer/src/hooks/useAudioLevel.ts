import { useCallback, useRef } from "react";

// Exponential smoothing so the orb doesn't visibly jitter frame-to-frame —
// higher = snappier/more reactive, lower = smoother/laggier.
const SMOOTHING = 0.35;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export interface AudioLevelController {
  /** Attach to the AICore element (via its forwarded ref) — this is the DOM
   * node --core-level gets written to directly. */
  elementRef: React.RefObject<HTMLDivElement>;
  /** Feed a raw mic frame (e.g. from VAD's onFrameProcessed) while listening. */
  setLevelFromMicFrame: (frame: Float32Array) => void;
  /** Taps an Audio element's real output waveform for the duration of
   * playback — returns a stop function to call once playback ends. */
  attachPlayback: (audio: HTMLAudioElement) => () => void;
  /** Clears back to the CSS-authored baseline (idle/thinking/connecting) —
   * removes the inline override entirely rather than writing 0, since an
   * inline value of literally 0 would otherwise permanently shadow the
   * stylesheet's own default for every state from then on. */
  reset: () => void;
}

/**
 * Drives the AI orb's `--core-level` CSS custom property directly on its DOM
 * node — never through React state, since this updates at up to ~30-60Hz and
 * routing that through state would mean 30-60 re-renders/sec for a value
 * that's purely visual. Two sources feed it: raw mic frames while listening
 * (RMS computed straight from the Float32Array VAD already hands over
 * per-frame — no extra Web Audio graph needed for that side), and a real
 * AnalyserNode tapped onto the reply's Audio element while speaking (the one
 * place an analyser is unavoidable, since there's no other way to read a
 * playing <audio> element's waveform).
 */
export function useAudioLevel(): AudioLevelController {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const smoothedRef = useRef(0);
  const activeStopRef = useRef<(() => void) | null>(null);

  const writeLevel = useCallback((raw: number) => {
    if (prefersReducedMotion()) return;
    const clamped = Math.min(1, Math.max(0, raw));
    smoothedRef.current += (clamped - smoothedRef.current) * SMOOTHING;
    elementRef.current?.style.setProperty("--core-level", smoothedRef.current.toFixed(3));
  }, []);

  const setLevelFromMicFrame = useCallback(
    (frame: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      // Typical mic RMS for normal speech sits well under 1 — scale up so
      // the orb visibly reacts instead of barely nudging.
      writeLevel(rms * 4);
    },
    [writeLevel]
  );

  const reset = useCallback(() => {
    activeStopRef.current?.();
    activeStopRef.current = null;
    smoothedRef.current = 0;
    elementRef.current?.style.removeProperty("--core-level");
  }, []);

  const attachPlayback = useCallback(
    (audio: HTMLAudioElement): (() => void) => {
      // Only one playback/level-source should ever drive the orb at a time.
      activeStopRef.current?.();

      let raf = 0;
      let stopped = false;
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      // The analyser must sit between the source and the destination, or
      // routing the element's output into this graph at all would silence it
      // — createMediaElementSource takes over the element's audio output.
      source.connect(analyser);
      analyser.connect(ctx.destination);
      const data = new Uint8Array(analyser.frequencyBinCount);

      function tick(): void {
        if (stopped) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        writeLevel(Math.sqrt(sum / data.length) * 2.5);
        raf = requestAnimationFrame(tick);
      }
      tick();

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        cancelAnimationFrame(raf);
        source.disconnect();
        analyser.disconnect();
        void ctx.close();
        if (activeStopRef.current === stop) activeStopRef.current = null;
        elementRef.current?.style.removeProperty("--core-level");
        smoothedRef.current = 0;
      };
      activeStopRef.current = stop;
      return stop;
    },
    [writeLevel]
  );

  return { elementRef, setLevelFromMicFrame, attachPlayback, reset };
}
