import { create } from "zustand";
import type { ConnectionStatus } from "@/types/websocket";

interface ConnectionState {
  status: ConnectionStatus;
  latencyMs: number | null;
  lastEventTime: string | null;
  reconnectAttempts: number;
  fallbackPolling: boolean;
  setStatus: (status: ConnectionStatus) => void;
  setLatency: (ms: number) => void;
  recordEvent: () => void;
  incrementReconnect: () => void;
  resetReconnect: () => void;
  setFallbackPolling: (active: boolean) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "disconnected",
  latencyMs: null,
  lastEventTime: null,
  reconnectAttempts: 0,
  fallbackPolling: false,
  setStatus: (status) => set({ status }),
  setLatency: (ms) => set({ latencyMs: ms }),
  recordEvent: () => set({ lastEventTime: new Date().toISOString() }),
  incrementReconnect: () => set((s) => ({ reconnectAttempts: s.reconnectAttempts + 1 })),
  resetReconnect: () => set({ reconnectAttempts: 0 }),
  setFallbackPolling: (active) => set({ fallbackPolling: active }),
}));
