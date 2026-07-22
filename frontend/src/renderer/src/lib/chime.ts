/**
 * A short, synthesized acknowledgment chime played the instant a wake word
 * is detected — generated programmatically via the Web Audio API rather
 * than a bundled audio file, so there's nothing to source/ship for what's
 * just two tones. A quick ascending two-note "ding" plays instantly,
 * zero network/asset-load latency, before the "Yes?" speech (which does
 * need a real backend TTS call) follows.
 */
export function playWakeChime(): void {
  const ctx = new AudioContext();
  const now = ctx.currentTime;

  function tone(freq: number, start: number, duration: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.2, now + start + 0.02);
    gain.gain.linearRampToValueAtTime(0, now + start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.02);
  }

  tone(880, 0, 0.12); // A5
  tone(1318.51, 0.13, 0.18); // E6

  setTimeout(() => void ctx.close(), 500);
}
