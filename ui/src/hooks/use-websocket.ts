"use client";

import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { useIncidentStore } from "@/stores/incident-store";
import { useAgentStore } from "@/stores/agent-store";
import { useMetricsStore } from "@/stores/metrics-store";
import { useApprovalStore } from "@/stores/approval-store";
import type { WebSocketEvent } from "@/types/websocket";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3000/ws/vigil";
const MAX_RECONNECT_DELAY = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const IS_DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  const connectionStore = useConnectionStore();
  const incidentStore = useIncidentStore();
  const agentStore = useAgentStore();
  const metricsStore = useMetricsStore();
  const approvalStore = useApprovalStore();

  useEffect(() => {
    // In demo mode, simulate connected state
    if (IS_DEMO) {
      connectionStore.setStatus("connected");
      return;
    }

    function connect() {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        connectionStore.setStatus("connected");
        connectionStore.resetReconnect();
        connectionStore.setFallbackPolling(false);
        attemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        connectionStore.recordEvent();
        try {
          const parsed: WebSocketEvent = JSON.parse(event.data);
          dispatch(parsed);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        connectionStore.setStatus("reconnecting");
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    function dispatch(event: WebSocketEvent) {
      incidentStore.handleEvent(event);
      agentStore.handleEvent(event);
      metricsStore.handleEvent(event);
      approvalStore.handleEvent(event);
    }

    function scheduleReconnect() {
      attemptRef.current++;
      connectionStore.incrementReconnect();

      if (attemptRef.current > MAX_RECONNECT_ATTEMPTS) {
        connectionStore.setStatus("disconnected");
        connectionStore.setFallbackPolling(true);
        return;
      }

      // Exponential backoff with jitter
      const baseDelay = Math.min(1000 * Math.pow(2, attemptRef.current - 1), MAX_RECONNECT_DELAY);
      const jitter = Math.random() * 1000;
      const delay = baseDelay + jitter;

      reconnectTimerRef.current = setTimeout(connect, delay);
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
