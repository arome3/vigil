"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import type { FilterTab } from "@/stores/incident-store";

interface FilterTabsProps {
  activeTab: FilterTab;
  onTabChange: (tab: FilterTab) => void;
  counts: {
    all: number;
    active: number;
    resolved: number;
    escalated: number;
    suppressed: number;
  };
}

export function FilterTabs({ activeTab, onTabChange, counts }: FilterTabsProps) {
  const tabs = [
    { value: "all", label: "All", count: counts.all },
    { value: "active", label: "Active", count: counts.active },
    { value: "resolved", label: "Resolved", count: counts.resolved },
    { value: "escalated", label: "Escalated", count: counts.escalated, variant: "destructive" as const },
    { value: "suppressed", label: "Suppressed", count: counts.suppressed },
  ];

  return (
    <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as FilterTab)}>
      <TabsList className="bg-transparent gap-1 h-auto p-0">
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className="data-[state=active]:bg-accent data-[state=active]:text-foreground px-3 py-1.5 text-xs rounded-md"
          >
            {tab.label}
            <Badge
              variant={tab.value === "escalated" && tab.count > 0 ? "destructive" : "secondary"}
              className="ml-1.5 h-4 min-w-[16px] px-1 text-[10px]"
            >
              {tab.count}
            </Badge>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
