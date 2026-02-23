import type { Incident } from "@/types/incident";
import type { Agent, AgentActivityEntry } from "@/types/agent";
import type { DashboardMetrics, ServiceHealth } from "@/types/metrics";
import type { LearningRecord, Retrospective } from "@/types/learning";

const IS_DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

async function fetchApi<T>(path: string): Promise<T> {
  if (IS_DEMO) {
    return fetchMock<T>(path);
  }
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchMock<T>(path: string): Promise<T> {
  // Dynamic imports for mock data — tree-shaken in production
  if (path.startsWith("/api/vigil/incidents/") && !path.endsWith("/incidents")) {
    const id = path.split("/").pop();
    const { mockIncidents } = await import("@/data/mock/incidents");
    return (mockIncidents.find((i) => i.id === id) ?? mockIncidents[0]) as T;
  }
  if (path === "/api/vigil/incidents") {
    const { mockIncidents } = await import("@/data/mock/incidents");
    return mockIncidents as T;
  }
  if (path === "/api/vigil/agents") {
    const { mockAgents } = await import("@/data/mock/agents");
    return mockAgents as T;
  }
  if (path === "/api/vigil/metrics") {
    const { mockDashboardMetrics } = await import("@/data/mock/metrics");
    return mockDashboardMetrics as T;
  }
  if (path === "/api/vigil/health") {
    const { mockServiceHealth } = await import("@/data/mock/health");
    return mockServiceHealth as T;
  }
  if (path.startsWith("/api/vigil/activity")) {
    const { mockActivityFeed } = await import("@/data/mock/timeline");
    return mockActivityFeed as T;
  }
  if (path.startsWith("/api/vigil/learning/retrospectives/")) {
    const { mockRetrospective } = await import("@/data/mock/learning");
    return mockRetrospective as T;
  }
  if (path === "/api/vigil/learning") {
    const { mockLearningRecords } = await import("@/data/mock/learning");
    return mockLearningRecords as T;
  }
  throw new Error(`No mock data for path: ${path}`);
}

// ─── Typed API functions ─────────────────────────────────────

export function getIncidents(): Promise<Incident[]> {
  return fetchApi("/api/vigil/incidents");
}

export function getIncident(id: string): Promise<Incident> {
  return fetchApi(`/api/vigil/incidents/${id}`);
}

export function getAgents(): Promise<Agent[]> {
  return fetchApi("/api/vigil/agents");
}

export function getDashboardMetrics(): Promise<DashboardMetrics> {
  return fetchApi("/api/vigil/metrics");
}

export function getServiceHealth(): Promise<ServiceHealth[]> {
  return fetchApi("/api/vigil/health");
}

export function getActivityFeed(): Promise<AgentActivityEntry[]> {
  return fetchApi("/api/vigil/activity");
}

export function getLearningRecords(): Promise<LearningRecord[]> {
  return fetchApi("/api/vigil/learning");
}

export function getRetrospective(id: string): Promise<Retrospective> {
  return fetchApi(`/api/vigil/learning/retrospectives/${id}`);
}
