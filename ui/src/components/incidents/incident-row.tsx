"use client";

import Link from "next/link";
import { TableRow, TableCell } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/badges/status-badge";
import { SeverityBadge } from "@/components/badges/severity-badge";
import { MonoText } from "@/components/shared/mono-text";
import { AGENT_CONFIG } from "@/lib/constants";
import { formatRelativeTime, formatDuration } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { Incident } from "@/types/incident";
import type { AgentName } from "@/types/agent";

interface IncidentRowProps {
  incident: Incident;
  isSelected: boolean;
  isChecked: boolean;
  onToggleCheck: () => void;
  isNew?: boolean;
}

export function IncidentRow({ incident, isSelected, isChecked, onToggleCheck, isNew }: IncidentRowProps) {
  const agentConfig = incident.current_agent ? AGENT_CONFIG[incident.current_agent as AgentName] : null;
  const AgentIcon = agentConfig?.icon;
  const durationMs = incident.timing_metrics
    ? incident.timing_metrics.total_duration_seconds * 1000
    : Date.now() - new Date(incident.created_at).getTime();

  return (
    <TableRow
      className={cn(
        "cursor-pointer transition-colors",
        isSelected && "bg-accent/30",
        isNew && "animate-incident-highlight"
      )}
    >
      <TableCell className="w-8">
        <Checkbox
          checked={isChecked}
          onCheckedChange={() => onToggleCheck()}
          aria-label={`Select ${incident.id}`}
        />
      </TableCell>
      <TableCell>
        <StatusBadge status={incident.status} size="sm" />
      </TableCell>
      <TableCell>
        <SeverityBadge severity={incident.severity} size="sm" />
      </TableCell>
      <TableCell>
        <Link href={`/incidents/${incident.id}`} className="hover:underline">
          <MonoText>{incident.id}</MonoText>
        </Link>
      </TableCell>
      <TableCell className="max-w-[300px]">
        <Link href={`/incidents/${incident.id}`} className="text-xs truncate block hover:underline">
          {incident.title}
        </Link>
      </TableCell>
      <TableCell>
        <span className={cn(
          "inline-flex px-2 py-0.5 rounded text-[10px] font-medium",
          incident.type === "security" ? "bg-error/10 text-error" : "bg-warning/10 text-warning"
        )}>
          {incident.type}
        </span>
      </TableCell>
      <TableCell className="text-xs tabular-nums text-center">
        {incident.affected_assets.length}
      </TableCell>
      <TableCell>
        <MonoText className="text-muted-foreground">{formatRelativeTime(incident.created_at)}</MonoText>
      </TableCell>
      <TableCell>
        <MonoText className="text-muted-foreground">{formatDuration(durationMs)}</MonoText>
      </TableCell>
      <TableCell>
        {agentConfig && (
          <div className="flex items-center gap-1 text-xs" style={{ color: agentConfig.color }}>
            {AgentIcon && <AgentIcon className="h-3 w-3" />}
            <span>{agentConfig.label}</span>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
