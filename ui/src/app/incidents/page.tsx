"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { FilterTabs } from "@/components/incidents/filter-tabs";
import { IncidentRow } from "@/components/incidents/incident-row";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useIncidentStore } from "@/stores/incident-store";
import { useUIStore } from "@/stores/ui-store";
import { Shield } from "lucide-react";

export default function IncidentsPage() {
  const router = useRouter();
  const {
    setIncidents, setFilterTab, setSearchQuery, setSelectedId,
    toggleSelected, selectedIds, selectedId, filterTab, searchQuery,
    filteredIncidents, activeCount, resolvedCount, escalatedCount, suppressedCount,
  } = useIncidentStore();
  const pushContext = useUIStore((s) => s.pushKeyboardContext);
  const popContext = useUIStore((s) => s.popKeyboardContext);

  const [loading, setLoading] = useState(true);
  const incidents = filteredIncidents();
  const allCount = useIncidentStore((s) => s.incidents.size);

  useEffect(() => {
    pushContext("incidentList");
    return () => popContext();
  }, [pushContext, popContext]);

  useEffect(() => {
    async function load() {
      try {
        const { mockIncidents } = await import("@/data/mock/incidents");
        setIncidents(mockIncidents);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [setIncidents]);

  // Keyboard navigation
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT") return;

      if (e.key === "j") {
        e.preventDefault();
        const idx = incidents.findIndex((i) => i.id === selectedId);
        const next = incidents[Math.min(idx + 1, incidents.length - 1)];
        if (next) setSelectedId(next.id);
      }
      if (e.key === "k") {
        e.preventDefault();
        const idx = incidents.findIndex((i) => i.id === selectedId);
        const prev = incidents[Math.max(idx - 1, 0)];
        if (prev) setSelectedId(prev.id);
      }
      if (e.key === "Enter" && selectedId) {
        e.preventDefault();
        router.push(`/incidents/${selectedId}`);
      }
      if (e.key === "x" && selectedId) {
        e.preventDefault();
        toggleSelected(selectedId);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [incidents, selectedId, setSelectedId, toggleSelected, router]);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <FilterTabs
          activeTab={filterTab}
          onTabChange={setFilterTab}
          counts={{
            all: allCount,
            active: activeCount(),
            resolved: resolvedCount(),
            escalated: escalatedCount(),
            suppressed: suppressedCount(),
          }}
        />
        <Input
          placeholder="Search incidents..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-xs h-8 text-xs"
        />
      </div>

      {incidents.length === 0 ? (
        <EmptyState
          icon={Shield}
          title="No active incidents"
          subtitle="All systems nominal. Run a demo scenario to see Vigil in action."
        />
      ) : (
        <div className="border border-border-subtle rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="text-xs w-32">Status</TableHead>
                <TableHead className="text-xs w-24">Severity</TableHead>
                <TableHead className="text-xs w-40">ID</TableHead>
                <TableHead className="text-xs">Title</TableHead>
                <TableHead className="text-xs w-24">Type</TableHead>
                <TableHead className="text-xs w-16 text-center">Assets</TableHead>
                <TableHead className="text-xs w-24">Created</TableHead>
                <TableHead className="text-xs w-20">Duration</TableHead>
                <TableHead className="text-xs w-32">Agent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.map((incident) => (
                <IncidentRow
                  key={incident.id}
                  incident={incident}
                  isSelected={selectedId === incident.id}
                  isChecked={selectedIds.has(incident.id)}
                  onToggleCheck={() => toggleSelected(incident.id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
