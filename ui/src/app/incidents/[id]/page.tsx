"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/badges/status-badge";
import { SeverityBadge } from "@/components/badges/severity-badge";
import { MonoText } from "@/components/shared/mono-text";
import { CopyButton } from "@/components/shared/copy-button";
import { TimelineEntry } from "@/components/incidents/timeline-entry";
import { RemediationChecklist } from "@/components/incidents/remediation-checklist";
import { VerificationPanel } from "@/components/incidents/verification-panel";
import { AttackChainGraph } from "@/components/visualization/attack-chain-graph";
import { MitreMatrix } from "@/components/visualization/mitre-matrix";
import { ChangeCorrelationTable } from "@/components/dashboard/change-correlation-table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration, formatDurationSeconds, formatRelativeTime } from "@/lib/formatters";
import { AGENT_CONFIG } from "@/lib/constants";
import { useUIStore } from "@/stores/ui-store";
import { AlertTriangle, ExternalLink } from "lucide-react";
import type { Incident } from "@/types/incident";
import type { AgentActivityEntry, AgentName } from "@/types/agent";
import type { MitreDetection } from "@/components/visualization/mitre-matrix";
import Link from "next/link";

export default function IncidentDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const pushContext = useUIStore((s) => s.pushKeyboardContext);
  const popContext = useUIStore((s) => s.popKeyboardContext);

  const [incident, setIncident] = useState<Incident | null>(null);
  const [timeline, setTimeline] = useState<AgentActivityEntry[]>([]);
  const [attackChain, setAttackChain] = useState<Array<{ data: Record<string, unknown> }>>([]);
  const [mitreDetections, setMitreDetections] = useState<MitreDetection[]>([]);
  const [activeTab, setActiveTab] = useState("timeline");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    pushContext("incidentDetail");
    return () => popContext();
  }, [pushContext, popContext]);

  // Tab keyboard shortcuts
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT") return;
      const tabs = ["timeline", "investigation", "remediation", "verification"];
      const num = parseInt(e.key);
      if (num >= 1 && num <= 4) {
        e.preventDefault();
        setActiveTab(tabs[num - 1]);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const [incModule, tlModule, acModule, mitreModule] = await Promise.all([
          import("@/data/mock/incidents"),
          import("@/data/mock/timeline"),
          import("@/data/mock/attack-chain"),
          import("@/data/mock/mitre"),
        ]);
        const found = incModule.mockIncidents.find((i: Incident) => i.id === id) ?? incModule.mockIncidents[0];
        setIncident(found);
        setTimeline(tlModule.mockTimelineEntries);
        setAttackChain(acModule.mockAttackChainElements);
        setMitreDetections(mitreModule.mockMitreDetections);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  if (loading || !incident) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-12 w-full" />
        <div className="grid lg:grid-cols-[1fr_380px] gap-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Escalation banner */}
      {incident.status === "escalated" && (
        <div className="flex items-center gap-2 p-3 rounded-lg border-2 border-error bg-error/5" role="alert" aria-live="assertive">
          <AlertTriangle className="h-5 w-5 text-error shrink-0" />
          <span className="text-sm font-medium text-error">This incident has been escalated and requires immediate human attention.</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={incident.status} />
        <SeverityBadge severity={incident.severity} />
        <div className="flex items-center gap-1">
          <MonoText className="text-sm font-bold">{incident.id}</MonoText>
          <CopyButton value={incident.id} />
        </div>
        <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${incident.type === "security" ? "bg-error/10 text-error" : "bg-warning/10 text-warning"}`}>
          {incident.type}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm">Escalate</Button>
          <Button variant="outline" size="sm">Suppress</Button>
          <Button variant="outline" size="sm">Export</Button>
        </div>
      </div>

      <h1 className="text-lg font-semibold">{incident.title}</h1>

      <div className="grid lg:grid-cols-[1fr_380px] gap-4">
        {/* Main column */}
        <div>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="timeline">Timeline <kbd className="ml-1 text-[10px] opacity-50">1</kbd></TabsTrigger>
              <TabsTrigger value="investigation">Investigation <kbd className="ml-1 text-[10px] opacity-50">2</kbd></TabsTrigger>
              <TabsTrigger value="remediation">Remediation <kbd className="ml-1 text-[10px] opacity-50">3</kbd></TabsTrigger>
              <TabsTrigger value="verification">Verification <kbd className="ml-1 text-[10px] opacity-50">4</kbd></TabsTrigger>
            </TabsList>

            <TabsContent value="timeline" className="mt-4 space-y-0">
              {timeline.map((entry) => (
                <TimelineEntry key={entry.id} entry={entry} />
              ))}
            </TabsContent>

            <TabsContent value="investigation" className="mt-4 space-y-4">
              {incident.type === "security" ? (
                <>
                  <AttackChainGraph elements={attackChain} />
                  <MitreMatrix detections={mitreDetections} />
                  {incident.investigation?.blast_radius && (
                    <Card>
                      <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Blast Radius</CardTitle></CardHeader>
                      <CardContent>
                        <div className="space-y-1">
                          {incident.investigation.blast_radius.map((a) => (
                            <div key={a.asset_id} className="flex items-center justify-between text-xs py-1.5 border-b border-border-subtle/50 last:border-0">
                              <span className="font-mono">{a.asset_name}</span>
                              <div className="flex items-center gap-2">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] ${a.criticality === "tier-1" ? "bg-error/10 text-error" : a.criticality === "tier-2" ? "bg-warning/10 text-warning" : "bg-info/10 text-info"}`}>{a.criticality}</span>
                                <span className="text-muted-foreground">{a.impact_type}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <>
                  {incident.investigation?.change_correlation && (
                    <ChangeCorrelationTable rows={[{
                      incident_id: incident.id,
                      commit_sha: incident.investigation.change_correlation.commit_sha,
                      author: incident.investigation.change_correlation.author,
                      pr_number: incident.investigation.change_correlation.pr_number,
                      time_gap_seconds: incident.investigation.change_correlation.time_gap_seconds,
                      confidence: incident.investigation.change_correlation.confidence,
                    }]} />
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent value="remediation" className="mt-4">
              {incident.remediation_plan ? (
                <RemediationChecklist actions={incident.remediation_plan.actions} />
              ) : (
                <p className="text-xs text-muted-foreground text-center py-8">No remediation plan generated yet.</p>
              )}
            </TabsContent>

            <TabsContent value="verification" className="mt-4">
              {incident.verification ? (
                <VerificationPanel verification={incident.verification} />
              ) : (
                <p className="text-xs text-muted-foreground text-center py-8">Verification not yet started.</p>
              )}
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Timing Metrics */}
          {incident.timing_metrics && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Timing Metrics</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {[
                    { label: "TTD", value: incident.timing_metrics.time_to_detect_seconds, color: "#94A3B8" },
                    { label: "TTI", value: incident.timing_metrics.time_to_investigate_seconds, color: "#3B82F6" },
                    { label: "TTR", value: incident.timing_metrics.time_to_remediate_seconds, color: "#F59E0B" },
                    { label: "TTV", value: incident.timing_metrics.time_to_verify_seconds, color: "#22C55E" },
                  ].map((m) => {
                    const pct = (m.value / incident.timing_metrics!.total_duration_seconds) * 100;
                    return (
                      <div key={m.label} className="flex items-center gap-2 text-xs">
                        <span className="w-8 font-medium">{m.label}</span>
                        <div className="flex-1 h-4 bg-surface-sunken rounded-sm overflow-hidden">
                          <div className="h-full rounded-sm" style={{ width: `${pct}%`, backgroundColor: m.color }} />
                        </div>
                        <MonoText className="w-12 text-right text-muted-foreground">{formatDurationSeconds(m.value)}</MonoText>
                      </div>
                    );
                  })}
                  <div className="flex justify-between text-xs pt-1 border-t border-border-subtle">
                    <span className="font-medium">Total</span>
                    <MonoText>{formatDurationSeconds(incident.timing_metrics.total_duration_seconds)}</MonoText>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Affected Assets */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Affected Assets ({incident.affected_assets.length})</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-1">
                {incident.affected_assets.map((a) => (
                  <div key={a.asset_id} className="flex items-center justify-between text-xs py-1 border-b border-border-subtle/50 last:border-0">
                    <MonoText>{a.asset_name}</MonoText>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${a.criticality === "tier-1" ? "bg-error/10 text-error" : a.criticality === "tier-2" ? "bg-warning/10 text-warning" : "bg-info/10 text-info"}`}>{a.criticality}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* External Links */}
          {incident.external_links && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">External Links</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {Object.entries(incident.external_links).filter(([, v]) => v).map(([key, url]) => (
                    <a key={key} href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs text-info hover:underline py-1">
                      <ExternalLink className="h-3 w-3" />
                      {key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </a>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Agent Trace link */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Agent Participation</CardTitle></CardHeader>
            <CardContent>
              <Link href={`/incidents/${incident.id}/trace`} className="text-xs text-info hover:underline">
                View full agent trace →
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
