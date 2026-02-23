export interface MitreDetection {
  technique_id: string;
  technique_name: string;
  tactic: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: number;
  incident_ids: string[];
}

export const mockMitreDetections: MitreDetection[] = [
  {
    technique_id: "T1552",
    technique_name: "Unsecured Credentials",
    tactic: "Credential Access",
    severity: "critical",
    confidence: 0.95,
    incident_ids: ["INC-2026-00142"],
  },
  {
    technique_id: "T1078",
    technique_name: "Valid Accounts",
    tactic: "Defense Evasion",
    severity: "high",
    confidence: 0.88,
    incident_ids: ["INC-2026-00142"],
  },
  {
    technique_id: "T1071",
    technique_name: "Application Layer Protocol",
    tactic: "Command and Control",
    severity: "high",
    confidence: 0.82,
    incident_ids: ["INC-2026-00142"],
  },
  {
    technique_id: "T1041",
    technique_name: "Exfiltration Over C2 Channel",
    tactic: "Exfiltration",
    severity: "critical",
    confidence: 0.91,
    incident_ids: ["INC-2026-00142"],
  },
  {
    technique_id: "T1005",
    technique_name: "Data from Local System",
    tactic: "Collection",
    severity: "medium",
    confidence: 0.87,
    incident_ids: ["INC-2026-00142"],
  },
];
