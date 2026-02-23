/**
 * Format milliseconds as human-readable duration.
 * e.g., 252000 → "4m 12s"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Format seconds as human-readable duration.
 */
export function formatDurationSeconds(seconds: number): string {
  return formatDuration(seconds * 1000);
}

/**
 * Format ISO timestamp as relative time.
 * e.g., "2m ago", "1h ago", "3d ago"
 */
export function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format incident ID for display.
 */
export function formatIncidentId(id: string): string {
  return id;
}

/**
 * Format a number with comma separators.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Format a percentage (0-1 range).
 */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Truncate a commit SHA to 7 characters.
 */
export function formatSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Format a confidence level string from a time gap in seconds.
 */
export function confidenceFromTimeGap(seconds: number): "high" | "medium" | "low" {
  if (seconds < 300) return "high";
  if (seconds < 600) return "medium";
  return "low";
}
