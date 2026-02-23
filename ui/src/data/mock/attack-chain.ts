/**
 * Attack chain graph elements for Cytoscape.js visualization.
 * Scenario 1: INC-2026-00142 — Compromised API Key
 */

export interface AttackChainElement {
  data: {
    id: string;
    label: string;
    type?: "user" | "ip" | "host" | "service" | "external";
    color?: string;
    source?: string;
    target?: string;
    technique_id?: string;
    confidence?: number;
  };
}

export const mockAttackChainElements: AttackChainElement[] = [
  // --- Nodes ---
  {
    data: {
      id: "svc-payment",
      label: "svc-payment",
      type: "user",
      color: "#9333ea", // purple
    },
  },
  {
    data: {
      id: "203.0.113.42",
      label: "203.0.113.42\n(attacker)",
      type: "ip",
      color: "#3b82f6", // blue
    },
  },
  {
    data: {
      id: "srv-payment-01",
      label: "srv-payment-01",
      type: "host",
      color: "#06b6d4", // cyan
    },
  },
  {
    data: {
      id: "api-gateway",
      label: "api-gateway",
      type: "service",
      color: "#f59e0b", // amber
    },
  },
  {
    data: {
      id: "198.51.100.10",
      label: "198.51.100.10\n(C2 server)",
      type: "external",
      color: "#ef4444", // red
    },
  },
  {
    data: {
      id: "db-customers",
      label: "db-customers",
      type: "host",
      color: "#06b6d4", // cyan
    },
  },

  // --- Edges ---
  {
    data: {
      id: "edge-1",
      source: "svc-payment",
      target: "srv-payment-01",
      label: "T1552 Credential Access",
      technique_id: "T1552",
      confidence: 0.95,
    },
  },
  {
    data: {
      id: "edge-2",
      source: "203.0.113.42",
      target: "srv-payment-01",
      label: "T1078 Valid Accounts",
      technique_id: "T1078",
      confidence: 0.88,
    },
  },
  {
    data: {
      id: "edge-3",
      source: "srv-payment-01",
      target: "api-gateway",
      label: "T1071 Application Layer Protocol",
      technique_id: "T1071",
      confidence: 0.82,
    },
  },
  {
    data: {
      id: "edge-4",
      source: "srv-payment-01",
      target: "198.51.100.10",
      label: "T1041 Exfiltration Over C2",
      technique_id: "T1041",
      confidence: 0.91,
    },
  },
  {
    data: {
      id: "edge-5",
      source: "srv-payment-01",
      target: "db-customers",
      label: "T1005 Data from Local System",
      technique_id: "T1005",
      confidence: 0.87,
    },
  },
];
