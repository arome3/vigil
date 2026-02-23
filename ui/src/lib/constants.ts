import {
  AlertCircle, Filter, Search, Crosshair, Eye, ClipboardList,
  Zap, ShieldCheck, TrendingUp, Brain, RefreshCw, Clock,
  CheckCircle, CheckCheck, AlertTriangle, XCircle,
  Globe, User, Server, Box, ExternalLink, FileText, MessageSquare,
  type LucideIcon,
} from "lucide-react";
import type { AgentName } from "@/types/agent";
import type { IncidentStatus, Severity } from "@/types/incident";

// ─── Agent Configuration ─────────────────────────────────────
export const AGENT_CONFIG: Record<AgentName, { icon: LucideIcon; color: string; label: string }> = {
  "vigil-coordinator":   { icon: Brain,        color: "var(--color-agent-coordinator)",   label: "Coordinator" },
  "vigil-triage":        { icon: Filter,       color: "var(--color-agent-triage)",        label: "Triage" },
  "vigil-investigator":  { icon: Search,       color: "var(--color-agent-investigator)",  label: "Investigator" },
  "vigil-threat-hunter": { icon: Crosshair,    color: "var(--color-agent-threat-hunter)", label: "Threat Hunter" },
  "vigil-sentinel":      { icon: Eye,          color: "var(--color-agent-sentinel)",      label: "Sentinel" },
  "vigil-commander":     { icon: ClipboardList, color: "var(--color-agent-commander)",    label: "Commander" },
  "vigil-executor":      { icon: Zap,          color: "var(--color-agent-executor)",      label: "Executor" },
  "vigil-verifier":      { icon: ShieldCheck,  color: "var(--color-agent-verifier)",      label: "Verifier" },
  "vigil-analyst":       { icon: TrendingUp,   color: "var(--color-agent-analyst)",       label: "Analyst" },
  "vigil-reporter":      { icon: FileText,     color: "var(--color-agent-reporter)",      label: "Reporter" },
  "vigil-chat":          { icon: MessageSquare, color: "var(--color-agent-chat)",         label: "Chat" },
};

// ─── State Machine Configuration ─────────────────────────────
export const STATE_CONFIG: Record<IncidentStatus, { icon: LucideIcon; color: string; bgColor: string; label: string }> = {
  detected:          { icon: AlertCircle,    color: "var(--color-state-detected)",          bgColor: "rgba(148, 163, 184, 0.15)", label: "Detected" },
  triaged:           { icon: Filter,         color: "var(--color-state-triaged)",           bgColor: "rgba(167, 139, 250, 0.15)", label: "Triaged" },
  investigating:     { icon: Search,         color: "var(--color-state-investigating)",     bgColor: "rgba(59, 130, 246, 0.15)",  label: "Investigating" },
  threat_hunting:    { icon: Crosshair,      color: "var(--color-state-threat-hunting)",    bgColor: "rgba(139, 92, 246, 0.15)",  label: "Threat Hunting" },
  planning:          { icon: ClipboardList,  color: "var(--color-state-planning)",          bgColor: "rgba(245, 158, 11, 0.15)", label: "Planning" },
  awaiting_approval: { icon: Clock,          color: "var(--color-state-awaiting-approval)", bgColor: "rgba(251, 146, 60, 0.15)", label: "Awaiting Approval" },
  executing:         { icon: Zap,            color: "var(--color-state-executing)",         bgColor: "rgba(251, 191, 36, 0.15)", label: "Executing" },
  verifying:         { icon: CheckCircle,    color: "var(--color-state-verifying)",         bgColor: "rgba(45, 212, 191, 0.15)", label: "Verifying" },
  reflecting:        { icon: RefreshCw,      color: "var(--color-state-reflecting)",        bgColor: "rgba(192, 132, 252, 0.15)", label: "Reflecting" },
  resolved:          { icon: CheckCheck,     color: "var(--color-state-resolved)",          bgColor: "rgba(34, 197, 94, 0.15)",  label: "Resolved" },
  escalated:         { icon: AlertTriangle,  color: "var(--color-state-escalated)",         bgColor: "rgba(239, 68, 68, 0.15)",  label: "Escalated" },
  suppressed:        { icon: XCircle,        color: "var(--color-state-suppressed)",        bgColor: "rgba(100, 116, 139, 0.15)", label: "Suppressed" },
};

// ─── Severity Configuration ──────────────────────────────────
export const SEVERITY_CONFIG: Record<Severity, { icon: LucideIcon; color: string; bgColor: string }> = {
  critical: { icon: AlertTriangle, color: "var(--color-severity-critical)", bgColor: "var(--color-severity-critical-bg)" },
  high:     { icon: AlertCircle,   color: "var(--color-severity-high)",     bgColor: "var(--color-severity-high-bg)" },
  medium:   { icon: AlertCircle,   color: "var(--color-severity-medium)",   bgColor: "var(--color-severity-medium-bg)" },
  low:      { icon: AlertCircle,   color: "var(--color-severity-low)",      bgColor: "var(--color-severity-low-bg)" },
  info:     { icon: AlertCircle,   color: "var(--color-severity-info)",     bgColor: "var(--color-severity-info-bg)" },
};

// ─── Attack chain node types ─────────────────────────────────
export const ATTACK_CHAIN_NODE_CONFIG = {
  ip:       { icon: Globe,        shape: "ellipse",          color: "#3B82F6" },
  user:     { icon: User,         shape: "ellipse",          color: "#8B5CF6" },
  host:     { icon: Server,       shape: "round-rectangle",  color: "#06B6D4" },
  service:  { icon: Box,          shape: "round-rectangle",  color: "#F59E0B" },
  external: { icon: ExternalLink, shape: "ellipse",          color: "#EF4444" },
} as const;

// ─── Navigation ──────────────────────────────────────────────
export const NAV_ITEMS = [
  { label: "Dashboard", href: "/",          shortcut: "D" },
  { label: "Incidents", href: "/incidents",  shortcut: "I" },
  { label: "Agents",    href: "/agents",     shortcut: "G" },
  { label: "Learning",  href: "/learning",   shortcut: "L" },
  { label: "Settings",  href: "/settings",   shortcut: null },
] as const;

// ─── Keyboard Shortcuts ──────────────────────────────────────
export const KEYBOARD_SHORTCUTS = {
  global: [
    { keys: ["Meta", "k"], label: "Cmd+K", description: "Open command palette" },
    { keys: ["?"], label: "?", description: "Keyboard shortcuts" },
    { keys: ["d"], label: "D", description: "Go to Dashboard" },
    { keys: ["i"], label: "I", description: "Go to Incidents" },
    { keys: ["g"], label: "G", description: "Go to Agents" },
    { keys: ["l"], label: "L", description: "Go to Learning" },
  ],
  incidentList: [
    { keys: ["j"], label: "j", description: "Next incident" },
    { keys: ["k"], label: "k", description: "Previous incident" },
    { keys: ["Enter"], label: "Enter", description: "Open incident" },
    { keys: ["e"], label: "e", description: "Escalate" },
    { keys: ["s"], label: "s", description: "Suppress" },
    { keys: ["x"], label: "x", description: "Toggle selection" },
  ],
  incidentDetail: [
    { keys: ["1"], label: "1", description: "Timeline tab" },
    { keys: ["2"], label: "2", description: "Investigation tab" },
    { keys: ["3"], label: "3", description: "Remediation tab" },
    { keys: ["4"], label: "4", description: "Verification tab" },
    { keys: ["["], label: "[", description: "Previous incident" },
    { keys: ["]"], label: "]", description: "Next incident" },
  ],
  approvalModal: [
    { keys: ["a"], label: "A", description: "Approve" },
    { keys: ["r"], label: "R", description: "Reject" },
    { keys: ["Escape"], label: "Esc", description: "Dismiss" },
  ],
} as const;
