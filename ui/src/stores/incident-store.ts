import { create } from "zustand";
import type { Incident, IncidentStatus } from "@/types/incident";
import type { WebSocketEvent } from "@/types/websocket";

export type FilterTab = "all" | "active" | "resolved" | "escalated" | "suppressed";

interface IncidentState {
  incidents: Map<string, Incident>;
  filterTab: FilterTab;
  searchQuery: string;
  selectedId: string | null;
  selectedIds: Set<string>;

  // Actions
  setIncidents: (incidents: Incident[]) => void;
  setFilterTab: (tab: FilterTab) => void;
  setSearchQuery: (query: string) => void;
  setSelectedId: (id: string | null) => void;
  toggleSelected: (id: string) => void;
  handleEvent: (event: WebSocketEvent) => void;

  // Computed
  filteredIncidents: () => Incident[];
  activeCount: () => number;
  resolvedCount: () => number;
  escalatedCount: () => number;
  suppressedCount: () => number;
}

const ACTIVE_STATUSES: IncidentStatus[] = [
  "detected", "triaged", "investigating", "threat_hunting",
  "planning", "awaiting_approval", "executing", "verifying", "reflecting",
];

export const useIncidentStore = create<IncidentState>((set, get) => ({
  incidents: new Map(),
  filterTab: "all",
  searchQuery: "",
  selectedId: null,
  selectedIds: new Set(),

  setIncidents: (incidents) => {
    const map = new Map<string, Incident>();
    incidents.forEach((i) => map.set(i.id, i));
    set({ incidents: map });
  },

  setFilterTab: (tab) => set({ filterTab: tab }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedId: (id) => set({ selectedId: id }),

  toggleSelected: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),

  handleEvent: (event) => {
    set((s) => {
      const next = new Map(s.incidents);
      switch (event.type) {
        case "incident.created":
          next.set(event.data.id, event.data);
          break;
        case "incident.state_changed":
          next.set(event.data.id, event.data.incident);
          break;
        case "incident.updated":
          next.set(event.data.id, event.data);
          break;
      }
      return { incidents: next };
    });
  },

  filteredIncidents: () => {
    const { incidents, filterTab, searchQuery } = get();
    let list = Array.from(incidents.values());

    switch (filterTab) {
      case "active":
        list = list.filter((i) => ACTIVE_STATUSES.includes(i.status));
        break;
      case "resolved":
        list = list.filter((i) => i.status === "resolved");
        break;
      case "escalated":
        list = list.filter((i) => i.status === "escalated");
        break;
      case "suppressed":
        list = list.filter((i) => i.status === "suppressed");
        break;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (i) =>
          i.id.toLowerCase().includes(q) ||
          i.title.toLowerCase().includes(q) ||
          i.type.toLowerCase().includes(q)
      );
    }

    return list.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  },

  activeCount: () => {
    const { incidents } = get();
    return Array.from(incidents.values()).filter((i) => ACTIVE_STATUSES.includes(i.status)).length;
  },
  resolvedCount: () => {
    const { incidents } = get();
    return Array.from(incidents.values()).filter((i) => i.status === "resolved").length;
  },
  escalatedCount: () => {
    const { incidents } = get();
    return Array.from(incidents.values()).filter((i) => i.status === "escalated").length;
  },
  suppressedCount: () => {
    const { incidents } = get();
    return Array.from(incidents.values()).filter((i) => i.status === "suppressed").length;
  },
}));
