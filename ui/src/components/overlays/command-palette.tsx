"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList,
} from "@/components/ui/command";
import { AGENT_CONFIG, NAV_ITEMS, STATE_CONFIG } from "@/lib/constants";
import { useUIStore } from "@/stores/ui-store";
import { useIncidentStore } from "@/stores/incident-store";
import type { AgentName } from "@/types/agent";

export function CommandPalette() {
  const router = useRouter();
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const incidentMap = useIncidentStore((s) => s.incidents);
  const incidents = Array.from(incidentMap.values());

  function navigate(path: string) {
    router.push(path);
    setOpen(false);
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search incidents, agents, views..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Views */}
        <CommandGroup heading="Views">
          {NAV_ITEMS.map((item) => (
            <CommandItem key={item.href} onSelect={() => navigate(item.href)}>
              <span className="flex-1">{item.label}</span>
              {item.shortcut && (
                <kbd className="ml-2 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono">
                  {item.shortcut}
                </kbd>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        {/* Incidents */}
        {incidents.length > 0 && (
          <CommandGroup heading="Incidents">
            {incidents.slice(0, 10).map((inc) => {
              const stateConfig = STATE_CONFIG[inc.status];
              const StateIcon = stateConfig.icon;
              return (
                <CommandItem key={inc.id} onSelect={() => navigate(`/incidents/${inc.id}`)}>
                  <StateIcon className="h-3 w-3 mr-2 shrink-0" style={{ color: stateConfig.color }} />
                  <span className="font-mono text-xs mr-2">{inc.id}</span>
                  <span className="text-xs truncate flex-1">{inc.title}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {/* Agents */}
        <CommandGroup heading="Agents">
          {Object.entries(AGENT_CONFIG).map(([name, config]) => {
            const Icon = config.icon;
            return (
              <CommandItem key={name} onSelect={() => navigate("/agents")}>
                <Icon className="h-3 w-3 mr-2" style={{ color: config.color }} />
                <span className="text-xs">{config.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
