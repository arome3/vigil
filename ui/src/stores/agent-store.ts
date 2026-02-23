import { create } from "zustand";
import type { AgentActivityEntry, TraceNode, AgentName } from "@/types/agent";
import type { WebSocketEvent } from "@/types/websocket";

interface AgentState {
  activityFeed: AgentActivityEntry[];
  traceTreeMap: Map<string, TraceNode>;
  agentStatuses: Map<AgentName, string>;

  addActivity: (entry: AgentActivityEntry) => void;
  setActivityFeed: (entries: AgentActivityEntry[]) => void;
  setTraceTree: (incidentId: string, tree: TraceNode) => void;
  handleEvent: (event: WebSocketEvent) => void;
}

const MAX_FEED_SIZE = 100;

export const useAgentStore = create<AgentState>((set) => ({
  activityFeed: [],
  traceTreeMap: new Map(),
  agentStatuses: new Map(),

  addActivity: (entry) =>
    set((s) => ({
      activityFeed: [entry, ...s.activityFeed].slice(0, MAX_FEED_SIZE),
    })),

  setActivityFeed: (entries) => set({ activityFeed: entries.slice(0, MAX_FEED_SIZE) }),

  setTraceTree: (incidentId, tree) =>
    set((s) => {
      const next = new Map(s.traceTreeMap);
      next.set(incidentId, tree);
      return { traceTreeMap: next };
    }),

  handleEvent: (event) => {
    set((s) => {
      switch (event.type) {
        case "agent.activity":
          return {
            activityFeed: [event.data, ...s.activityFeed].slice(0, MAX_FEED_SIZE),
          };
        default:
          return {};
      }
    });
  },
}));
