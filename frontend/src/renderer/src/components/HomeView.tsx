import { useEffect, useRef, useState } from "react";
import type { AIState, ChatMessage } from "../types/assistant";
import type { BackendStatus } from "../hooks/useBackendStatus";
import { SAMPLE_MESSAGES } from "../data/mockData";
import {
  converse,
  respondToText,
  playBase64WavControllable,
  synthesizeSpeech,
  type PendingConfirmation,
} from "../lib/voiceClient";
import { useVoiceConversation } from "../hooks/useVoiceConversation";
import { useAudioLevel } from "../hooks/useAudioLevel";
import { playWakeChime } from "../lib/chime";
import AICore from "./AICore";
import StatusDisplay from "./StatusDisplay";
import ChatArea from "./ChatArea";
import Composer from "./Composer";
import ConfirmDialog from "./ConfirmDialog";

let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  return `msg-${messageCounter}`;
}

/**
 * Home screen: AI core + status + chat + composer.
 *
 * Real voice pipeline: pressing the mic toggles continuous "voice mode"
 * (see useVoiceConversation) — Voice Activity Detection decides when the
 * user has actually finished speaking, at which point the utterance is
 * POSTed to the backend's /api/voice/converse (speech-to-text -> AI ->
 * text-to-speech), the reply is played, and listening resumes automatically
 * without any further button presses. Typed messages skip speech
 * recognition but still get a spoken reply via /api/ai/respond. The orb
 * (AICore) reacts to real audio the whole time — mic level while listening,
 * TTS waveform while speaking — via useAudioLevel.ts, written straight to
 * its DOM node rather than through React state. This component only drives
 * recording/playback and UI state — the actual understanding and speech
 * logic lives in backend/app/ai and backend/app/voice.
 */
interface HomeViewProps {
  backendStatus: BackendStatus;
}

export default function HomeView({ backendStatus }: HomeViewProps): JSX.Element {
  const [processingState, setProcessingState] = useState<"thinking" | "speaking" | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(SAMPLE_MESSAGES);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [livePartialText, setLivePartialText] = useState<string | null>(null);

  const { elementRef: coreRef, setLevelFromMicFrame, attachPlayback, reset: resetAudioLevel } = useAudioLevel();

  function addMessage(role: ChatMessage["role"], text: string): void {
    setMessages((prev) => [...prev, { id: nextId(), role, text, timestamp: Date.now() }]);
  }

  // Shared by the typed-message paths (handleSend/handleDialogConfirm) and
  // the wake acknowledgment — not by handleUtterance, which uses
  // speakWithBargeIn instead so talking over JARVIS stops it immediately.
  async function speakReply(reply: string | null, audioBase64: string): Promise<void> {
    if (reply !== null) addMessage("assistant", reply);
    setProcessingState("speaking");
    const playback = playBase64WavControllable(audioBase64);
    const stopLevel = attachPlayback(playback.audio);
    await playback.done;
    stopLevel();
    setProcessingState(null);
  }

  // Called by useVoiceConversation once VAD decides the user has finished an
  // utterance — resolving this ends the "thinking"/"speaking" span, after
  // which the hook resumes listening automatically if voice mode is still on.
  // Uses speakWithBargeIn (not the plain speakReply above) so talking over
  // JARVIS while it replies stops playback immediately — see
  // useVoiceConversation.ts for how that's detected and how orb reactivity
  // during that playback is wired via onPlaybackStart.
  async function handleUtterance(wavBlob: Blob): Promise<void> {
    setLivePartialText(null);
    resetAudioLevel();
    setProcessingState("thinking");
    try {
      const { transcript, reply, audioBase64, confirmation } = await converse(wavBlob);
      if (transcript) addMessage("user", transcript);
      addMessage("assistant", reply);
      setProcessingState("speaking");
      await speakWithBargeIn(audioBase64);
      setProcessingState(null);
      setPendingConfirmation(confirmation);
    } catch {
      addMessage("assistant", "Sorry, I couldn't reach the voice backend just now.");
      setProcessingState(null);
    }
  }

  const { voiceModeActive, toggleVoiceMode, startFromWakeWord, speakWithBargeIn } = useVoiceConversation({
    onUtterance: handleUtterance,
    canListen: () => window.jarvis.settings.getMicrophone(),
    onSpeechStart: () => setLivePartialText(""),
    onPartialTranscript: (text) => setLivePartialText(text),
    onMicFrame: setLevelFromMicFrame,
    onPlaybackStart: attachPlayback,
    onError: (message) => addMessage("assistant", message),
  });

  // Lets the tray menu's "Activate Assistant" item toggle voice mode the same
  // way the mic button does, without resubscribing every render.
  const toggleVoiceModeRef = useRef(toggleVoiceMode);
  toggleVoiceModeRef.current = toggleVoiceMode;

  useEffect(() => {
    return window.jarvis.onActivateAssistant(() => toggleVoiceModeRef.current());
  }, []);

  // A wake-word detection ("Hey Jarvis" / "Jarvis") is distinct from a manual
  // mic press: play an instant chime, say a quick "Yes?" acknowledgment, and
  // only then start listening for the actual command — see
  // useVoiceConversation.ts's startFromWakeWord for the auto-return-to-
  // wake-word-mode behavior once the conversation goes quiet.
  const startFromWakeWordRef = useRef(startFromWakeWord);
  startFromWakeWordRef.current = startFromWakeWord;

  useEffect(() => {
    return window.jarvis.onWakeTriggered(() => {
      void (async () => {
        playWakeChime();
        try {
          const audioBase64 = await synthesizeSpeech("Yes?");
          await speakReply(null, audioBase64);
        } catch {
          // Missing the acknowledgment entirely isn't fatal — still start
          // listening for the command either way.
          setProcessingState(null);
        }
        startFromWakeWordRef.current();
      })();
    });
  }, []);

  async function handleSend(text: string): Promise<void> {
    addMessage("user", text);
    resetAudioLevel();
    setProcessingState("thinking");
    try {
      const { reply, audioBase64, confirmation } = await respondToText(text);
      await speakReply(reply, audioBase64);
      setPendingConfirmation(confirmation);
    } catch {
      addMessage("assistant", "Sorry, I couldn't reach the AI backend just now.");
      setProcessingState(null);
    }
  }

  // The confirmation dialog is a deterministic alternative to typing/saying
  // "yes"/"no" — it sends the exact same text through the exact same
  // pipeline, so the backend's confirmation flow needs no knowledge of it.
  async function handleDialogConfirm(answer: "yes" | "no"): Promise<void> {
    setConfirming(true);
    try {
      addMessage("user", answer === "yes" ? "Yes" : "No");
      resetAudioLevel();
      setProcessingState("thinking");
      const { reply, audioBase64, confirmation } = await respondToText(answer);
      await speakReply(reply, audioBase64);
      setPendingConfirmation(confirmation);
    } catch {
      addMessage("assistant", "Sorry, I couldn't reach the AI backend just now.");
      setProcessingState(null);
    } finally {
      setConfirming(false);
    }
  }

  // "listening" now spans the whole time voice mode is on and JARVIS isn't
  // actively thinking/speaking — covering both "waiting for you to talk" and
  // "actively hearing you talk", since AIState doesn't distinguish those yet.
  const state: AIState = processingState ?? (voiceModeActive ? "listening" : "idle");

  // The backend not being reachable overrides whatever the local state
  // machine thinks is happening — there's no point showing "idle" if a
  // message would just fail to send.
  const displayState: AIState = backendStatus === "online" ? state : "connecting";
  const composerDisabled = state === "thinking" || state === "speaking" || backendStatus !== "online";

  return (
    <div className="home-view">
      <div className="core-stage">
        <AICore ref={coreRef} state={displayState} />
        <StatusDisplay state={displayState} />
      </div>

      <ChatArea messages={messages} livePartialText={livePartialText} />

      <Composer
        state={displayState}
        disabled={composerDisabled}
        onSend={handleSend}
        onMicPress={toggleVoiceMode}
      />

      {pendingConfirmation && (
        <ConfirmDialog prompt={pendingConfirmation.prompt} busy={confirming} onConfirm={handleDialogConfirm} />
      )}
    </div>
  );
}
