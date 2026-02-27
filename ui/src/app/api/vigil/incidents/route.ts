import { NextResponse } from "next/server";
import client from "@/lib/elastic-client";
import type { Incident } from "@/types/incident";

export const dynamic = "force-dynamic";

function buildCC(cc: Record<string, unknown> | undefined) {
  if (!cc) return undefined;
  return {
    matched: (cc.matched as boolean) ?? false,
    commit_sha: (cc.commit_sha as string) ?? "",
    author: (cc.commit_author as string) ?? (cc.author as string) ?? "",
    pr_number: (cc.pr_number as number) ?? 0,
    pr_title: (cc.pr_title as string) ?? "",
    repo: (cc.repo as string) ?? "",
    time_gap_seconds: (cc.time_gap_seconds as number) ?? 0,
    confidence: (cc.confidence as "high") ?? "medium",
    files_changed: (cc.files_changed as string[]) ?? [],
  };
}

function mapIncident(hit: Record<string, unknown>): Incident {
  const s = hit._source as Record<string, unknown>;
  const inv = (s.investigation_report ?? s.investigation) as Record<string, unknown> | undefined;
  const rootCC = s.change_correlation as Record<string, unknown> | undefined;
  const plan = s.remediation_plan as Record<string, unknown> | undefined;
  const verifications = (s.verification_results ?? []) as Record<string, unknown>[];
  const latest = verifications[verifications.length - 1] as Record<string, unknown> | undefined;
  const timestamps = s._state_timestamps as Record<string, string> | undefined;

  // Derive timing from state timestamps
  let timing_metrics;
  if (timestamps) {
    const detected = timestamps.detected ? new Date(timestamps.detected).getTime() : 0;
    const triaged = timestamps.triaged ? new Date(timestamps.triaged).getTime() : 0;
    const investigating = timestamps.investigating ? new Date(timestamps.investigating).getTime() : 0;
    const planning = timestamps.planning ? new Date(timestamps.planning).getTime() : 0;
    const resolved = s.resolved_at ? new Date(s.resolved_at as string).getTime() : 0;
    timing_metrics = {
      time_to_detect_seconds: detected ? 0 : 0,
      time_to_investigate_seconds: triaged && investigating ? (investigating - triaged) / 1000 : 0,
      time_to_remediate_seconds: planning && resolved ? (resolved - planning) / 1000 : 0,
      time_to_verify_seconds: 0,
      total_duration_seconds: detected && resolved ? (resolved - detected) / 1000 : 0,
    };
  }

  return {
    id: s.incident_id as string,
    status: s.status as Incident["status"],
    severity: s.severity as Incident["severity"],
    type: (s.incident_type ?? "security") as Incident["type"],
    title: (s.investigation_summary as string)?.slice(0, 100) ?? `Incident ${s.incident_id}`,
    priority_score: (s.priority_score as number) ?? 0,
    created_at: s.created_at as string,
    updated_at: s.updated_at as string,
    resolved_at: s.resolved_at as string | undefined,
    timing_metrics,
    investigation: inv
      ? {
          investigation_id: (inv.investigation_id as string) ?? "",
          root_cause: (inv.root_cause as string) ?? "",
          attack_chain: ((inv.attack_chain ?? []) as Record<string, unknown>[]).map((ac, i) => ({
            step: i + 1,
            technique_id: (ac.action as string) ?? "",
            technique_name: (ac.action as string) ?? "",
            tactic: "",
            source: (ac.host as string) ?? "",
            target: "",
            confidence: 0.8,
            evidence_count: (ac.event_count as number) ?? 0,
          })),
          blast_radius: ((inv.blast_radius ?? []) as Record<string, unknown>[]).map((br) => ({
            asset_id: (br.asset_id as string) ?? "",
            asset_name: (br.asset_name as string) ?? "",
            asset_type: (br.asset_type as string) ?? "",
            criticality: (br.criticality as "tier-1") ?? "tier-2",
            impact_type: (br.impact_type as string) ?? "",
            confidence: (br.confidence as number) ?? 0,
          })),
          mitre_techniques: ((inv.mitre_techniques ?? []) as Record<string, unknown>[]).map(
            (t) => (t.technique_id as string) ?? ""
          ),
          recommended_next: (inv.recommended_next as "threat_hunt") ?? "plan_remediation",
          change_correlation: buildCC((inv.change_correlation as Record<string, unknown> | undefined) ?? rootCC),
        }
      : rootCC?.matched
        ? {
            investigation_id: "",
            root_cause: (s.investigation_summary as string) ?? "",
            attack_chain: [],
            blast_radius: [],
            mitre_techniques: [],
            recommended_next: "plan_remediation" as const,
            change_correlation: buildCC(rootCC),
          }
        : undefined,
    remediation_plan: plan
      ? {
          actions: ((plan.actions ?? []) as Record<string, unknown>[]).map((a) => ({
            order: (a.order as number) ?? 0,
            action_type: (a.action_type as "containment") ?? "remediation",
            description: (a.description as string) ?? "",
            target_system: (a.target_system as string) ?? "",
            approval_required: (a.approval_required as boolean) ?? false,
            status: "pending" as const,
          })),
          success_criteria: ((plan.success_criteria ?? []) as Record<string, unknown>[]).map((c) => ({
            metric: (c.metric as string) ?? "",
            operator: (c.operator as "lte") ?? "lte",
            threshold: (c.threshold as number) ?? 0,
            service_name: (c.service_name as string) ?? "",
          })),
        }
      : undefined,
    verification: latest
      ? {
          iteration: (latest.iteration as number) ?? 1,
          health_score: (latest.health_score as number) ?? 0,
          passed: (latest.passed as boolean) ?? false,
          criteria_results: ((latest.criteria_results ?? []) as Record<string, unknown>[]).map((cr) => ({
            metric: (cr.metric as string) ?? "",
            operator: (cr.operator as "lte") ?? "lte",
            threshold: (cr.threshold as number) ?? 0,
            service_name: (cr.service_name as string) ?? "",
            current_value: (cr.current_value as number) ?? 0,
            passed: (cr.passed as boolean) ?? false,
          })),
          failure_analysis: latest.failure_analysis as string | undefined,
        }
      : undefined,
    affected_assets: ((s.affected_assets ?? []) as Record<string, unknown>[]).map((a) => ({
      asset_id: (a.asset_id as string) ?? "",
      asset_name: (a.name as string) ?? (a.asset_name as string) ?? "",
      asset_type: (a.asset_type as string) ?? "host",
      criticality: (a.criticality as "tier-1") ?? "tier-2",
      impact_type: (a.impact_type as string) ?? "primary",
      confidence: (a.confidence as number) ?? 0.8,
    })),
    reflection_count: (s.reflection_count as number) ?? 0,
    _state_timestamps: timestamps,
  };
}

export async function GET() {
  try {
    const result = await client.search({
      index: "vigil-incidents",
      size: 50,
      sort: [{ created_at: "desc" }],
    });
    const incidents = result.hits.hits.map(mapIncident);
    return NextResponse.json(incidents);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export { mapIncident };
