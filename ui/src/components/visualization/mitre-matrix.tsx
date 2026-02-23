"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface MitreDetection {
  technique_id: string;
  technique_name: string;
  tactic: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: number;
  incident_ids: string[];
}

interface MitreMatrixProps {
  detections: MitreDetection[];
  compact?: boolean;
}

const SEVERITY_COLORS = {
  critical: "#EF4444",
  high: "#F97316",
  medium: "#F59E0B",
  low: "#3B82F6",
  info: "#06B6D4",
};

const TACTIC_ORDER = [
  "Initial Access", "Execution", "Persistence", "Privilege Escalation",
  "Defense Evasion", "Credential Access", "Discovery", "Lateral Movement",
  "Collection", "Command and Control", "Exfiltration", "Impact",
];

export function MitreMatrix({ detections, compact = false }: MitreMatrixProps) {
  const tacticMap = new Map<string, MitreDetection[]>();
  TACTIC_ORDER.forEach((t) => tacticMap.set(t, []));
  detections.forEach((d) => {
    const existing = tacticMap.get(d.tactic) || [];
    existing.push(d);
    tacticMap.set(d.tactic, existing);
  });

  const activeTactics = TACTIC_ORDER.filter((t) => (tacticMap.get(t)?.length || 0) > 0);

  if (activeTactics.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">MITRE ATT&CK Coverage</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground text-center py-4">No MITRE techniques detected.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">MITRE ATT&CK Coverage</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2 overflow-x-auto pb-2">
          {activeTactics.map((tactic) => (
            <div key={tactic} className="shrink-0">
              <h4 className="text-[10px] font-medium text-muted-foreground mb-1 truncate w-24">{tactic}</h4>
              <div className="space-y-1">
                {tacticMap.get(tactic)?.map((det) => (
                  <Tooltip key={det.technique_id}>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "rounded px-1.5 py-1 cursor-default",
                          compact ? "w-6 h-6" : "w-24"
                        )}
                        style={{
                          backgroundColor: `${SEVERITY_COLORS[det.severity]}20`,
                          borderLeft: `3px solid ${SEVERITY_COLORS[det.severity]}`,
                          opacity: 0.5 + det.confidence * 0.5,
                        }}
                      >
                        {!compact && (
                          <>
                            <p className="text-[10px] font-mono font-medium">{det.technique_id}</p>
                            <p className="text-[9px] text-muted-foreground truncate">{det.technique_name}</p>
                          </>
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="text-xs space-y-0.5">
                        <p className="font-medium">{det.technique_id}: {det.technique_name}</p>
                        <p className="text-muted-foreground">{det.tactic}</p>
                        <p>Confidence: {(det.confidence * 100).toFixed(0)}%</p>
                        <p>Incidents: {det.incident_ids.join(", ")}</p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
