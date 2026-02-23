"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfidenceBadge } from "@/components/badges/confidence-badge";
import { MonoText } from "@/components/shared/mono-text";
import { formatDuration } from "@/lib/formatters";

export interface ChangeCorrelationRow {
  incident_id: string;
  commit_sha: string;
  author: string;
  pr_number: number;
  time_gap_seconds: number;
  confidence: "high" | "medium" | "low";
}

interface ChangeCorrelationTableProps {
  rows: ChangeCorrelationRow[];
}

export function ChangeCorrelationTable({ rows }: ChangeCorrelationTableProps) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Change Correlations</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground text-center py-8">
            No change correlations detected — deploy a change to see LOOKUP JOIN in action.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Change Correlations</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Incident</TableHead>
              <TableHead className="text-xs">Commit</TableHead>
              <TableHead className="text-xs">Author</TableHead>
              <TableHead className="text-xs">PR</TableHead>
              <TableHead className="text-xs">Gap</TableHead>
              <TableHead className="text-xs">Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.incident_id} className="cursor-pointer hover:bg-accent/50">
                <TableCell>
                  <Link href={`/incidents/${row.incident_id}`} className="hover:underline">
                    <MonoText>{row.incident_id}</MonoText>
                  </Link>
                </TableCell>
                <TableCell><MonoText>{row.commit_sha.slice(0, 7)}</MonoText></TableCell>
                <TableCell className="text-xs">{row.author}</TableCell>
                <TableCell><MonoText>#{row.pr_number}</MonoText></TableCell>
                <TableCell><MonoText>{formatDuration(row.time_gap_seconds * 1000)}</MonoText></TableCell>
                <TableCell><ConfidenceBadge level={row.confidence} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
