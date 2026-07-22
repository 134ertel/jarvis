/**
 * SAMPLE_MESSAGES is just a static seed for the chat history on launch — real
 * conversation turns from here on come from the voice/AI backend (see HomeView).
 * System stats are real telemetry from the backend (see useSystemStats/systemClient),
 * no mock data here anymore.
 */

import type { ChatMessage } from "../types/assistant";

export const SAMPLE_MESSAGES: ChatMessage[] = [
  {
    id: "m1",
    role: "assistant",
    text: "Systems nominal. Press the microphone button or enable it in Settings, then just talk to me — try \"what time is it?\"",
    timestamp: Date.now() - 1000 * 60 * 2,
  },
];
