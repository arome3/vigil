export interface ChangeCorrelationRow {
  incident_id: string;
  commit_sha: string;
  author: string;
  pr_number: number;
  time_gap_seconds: number;
  confidence: "high" | "medium" | "low";
}

export const mockChangeCorrelations: ChangeCorrelationRow[] = [
  {
    incident_id: "INC-2026-00143",
    commit_sha: "a3f8c21",
    author: "j.martinez",
    pr_number: 847,
    time_gap_seconds: 42,
    confidence: "high",
  },
  {
    incident_id: "INC-2026-00140",
    commit_sha: "b7e9f13",
    author: "a.chen",
    pr_number: 842,
    time_gap_seconds: 480,
    confidence: "medium",
  },
  {
    incident_id: "INC-2026-00138",
    commit_sha: "c1d2e34",
    author: "k.patel",
    pr_number: 839,
    time_gap_seconds: 900,
    confidence: "low",
  },
];
