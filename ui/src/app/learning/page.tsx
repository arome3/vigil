"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { MonoText } from "@/components/shared/mono-text";
import { formatRelativeTime, formatPercent } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import Link from "next/link";
import type { LearningRecord } from "@/types/learning";

const TYPE_LABELS: Record<string, string> = {
  triage_calibration: "Triage Calibration",
  threshold_tuning: "Threshold Tuning",
  runbook_generation: "Runbook Generation",
  attack_pattern: "Attack Pattern",
  retrospective: "Retrospective",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-warning/15 text-warning",
  applied: "bg-success/15 text-success",
  rejected: "bg-error/15 text-error",
  expired: "bg-muted text-muted-foreground",
};

export default function LearningPage() {
  const [records, setRecords] = useState<LearningRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const { mockLearningRecords } = await import("@/data/mock/learning");
        setRecords(mockLearningRecords);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <h1 className="text-lg font-semibold">Learning & Analytics</h1>

      <div className="space-y-3">
        {records.map((record) => (
          <Card key={record.id} className="hover:border-border-strong transition-colors">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge className={cn("text-[10px] h-4 px-1.5", STATUS_STYLES[record.status])}>
                      {record.status}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">{TYPE_LABELS[record.type]}</span>
                  </div>
                  <h3 className="text-sm font-medium">{record.title}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{record.description}</p>
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                    <MonoText>{record.incident_id}</MonoText>
                    <span>Confidence: {formatPercent(record.confidence)}</span>
                    <span>{formatRelativeTime(record.created_at)}</span>
                  </div>
                </div>
                {record.type === "retrospective" && (
                  <Link
                    href={`/learning/retrospectives/${record.id}`}
                    className="text-xs text-info hover:underline shrink-0"
                  >
                    View →
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
