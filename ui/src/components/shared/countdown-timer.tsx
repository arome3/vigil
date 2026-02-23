"use client";

import { useEffect, useState, useRef } from "react";

interface CountdownTimerProps {
  timeoutAt: string;
  urgentThresholdSeconds?: number;
  size?: number;
}

export function CountdownTimer({
  timeoutAt,
  urgentThresholdSeconds = 120,
  size = 64,
}: CountdownTimerProps) {
  const [remaining, setRemaining] = useState(0);
  const [total, setTotal] = useState(0);
  const announceRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const endTime = new Date(timeoutAt).getTime();
    const now = Date.now();
    const totalSeconds = Math.max(0, Math.floor((endTime - now) / 1000));
    setTotal(totalSeconds);
    setRemaining(totalSeconds);

    const interval = setInterval(() => {
      const left = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) clearInterval(interval);
    }, 1000);

    return () => clearInterval(interval);
  }, [timeoutAt]);

  const progress = total > 0 ? remaining / total : 0;
  const isUrgent = remaining <= urgentThresholdSeconds;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress);
  const strokeColor = isUrgent ? "var(--color-error)" : "var(--color-warning)";

  // Announce milestones
  useEffect(() => {
    const milestones = [300, 120, 60, 30];
    for (const m of milestones) {
      if (remaining <= m && remaining > m - 2 && !announceRef.current.has(m)) {
        announceRef.current.add(m);
      }
    }
  }, [remaining]);

  return (
    <div
      role="timer"
      aria-label={`${minutes}m ${seconds}s remaining`}
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-border-subtle)"
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          className="transition-[stroke-dashoffset] duration-1000 ease-linear"
        />
      </svg>
      <span className="absolute font-mono text-xs font-bold" style={{ color: strokeColor }}>
        {minutes}:{seconds.toString().padStart(2, "0")}
      </span>
    </div>
  );
}
