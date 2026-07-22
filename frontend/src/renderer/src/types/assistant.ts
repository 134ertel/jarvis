export type AIState = "idle" | "listening" | "thinking" | "speaking" | "connecting";

export type NavKey = "home" | "conversations" | "memory" | "automations" | "ai" | "settings";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface SystemStats {
  cpuPercent: number;
  cpuTempC: number | null;
  gpuName: string | null;
  gpuPercent: number | null;
  gpuTempC: number | null;
  gpuVramUsedMb: number | null;
  gpuVramTotalMb: number | null;
  ramPercent: number;
  storagePercent: number;
  downloadKbps: number;
  uploadKbps: number;
  networkUp: boolean;
}
