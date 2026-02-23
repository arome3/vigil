"use client";

import { useEffect } from "react";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SeverityBadge } from "@/components/badges/severity-badge";
import { CountdownTimer } from "@/components/shared/countdown-timer";
import { ChevronDown } from "lucide-react";
import type { ApprovalRequest } from "@/types/approval";
import type { Severity } from "@/types/incident";

interface ApprovalModalProps {
  approval: ApprovalRequest | null;
  open: boolean;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

export function ApprovalModal({ approval, open, onClose, onApprove, onReject }: ApprovalModalProps) {
  // Keyboard shortcuts
  useEffect(() => {
    if (!open || !approval) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        onApprove(approval!.approval_id);
      }
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        onReject(approval!.approval_id);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, approval, onApprove, onReject]);

  if (!approval) return null;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="max-w-lg" role="alertdialog" aria-modal="true">
        <AlertDialogHeader>
          <div className="flex items-center justify-between">
            <AlertDialogTitle className="text-base">Approval Required</AlertDialogTitle>
            <CountdownTimer timeoutAt={approval.timeout_at} size={48} />
          </div>
          <AlertDialogDescription className="sr-only">
            Review and approve or reject the proposed remediation action.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 mt-2">
          {/* Incident summary */}
          <div className="flex items-center gap-2">
            <SeverityBadge severity={approval.severity as Severity} size="sm" />
            <span className="font-mono text-xs">{approval.incident_id}</span>
          </div>
          <p className="text-xs text-muted-foreground">{approval.incident_title}</p>

          {/* Proposed action */}
          <div className="p-3 rounded-lg bg-warning/5 border border-warning/20">
            <h4 className="text-xs font-medium text-warning mb-1">Proposed Action</h4>
            <p className="text-xs">{approval.proposed_action}</p>
          </div>

          {/* Impact assessment */}
          <div className="p-3 rounded-lg bg-surface-sunken">
            <h4 className="text-xs font-medium mb-1">Impact Assessment</h4>
            <p className="text-xs text-muted-foreground">{approval.impact_assessment}</p>
          </div>

          {/* Expandable evidence */}
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown className="h-3 w-3" />
              Investigation Evidence
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 p-3 rounded-lg bg-surface-sunken text-xs">
              {approval.investigation_summary}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <AlertDialogFooter className="mt-4 gap-2">
          <Button variant="destructive" size="sm" onClick={() => onReject(approval.approval_id)}>
            Reject <kbd className="ml-1 text-[10px] opacity-70">R</kbd>
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>
            More Info
          </Button>
          <Button variant="default" size="sm" onClick={() => onApprove(approval.approval_id)}>
            Approve & Execute <kbd className="ml-1 text-[10px] opacity-70">A</kbd>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
