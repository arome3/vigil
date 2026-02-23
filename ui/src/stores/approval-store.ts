import { create } from "zustand";
import type { ApprovalRequest } from "@/types/approval";
import type { WebSocketEvent } from "@/types/websocket";

interface ApprovalState {
  pendingApprovals: ApprovalRequest[];
  addApproval: (approval: ApprovalRequest) => void;
  removeApproval: (approvalId: string) => void;
  handleEvent: (event: WebSocketEvent) => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  pendingApprovals: [],

  addApproval: (approval) =>
    set((s) => ({
      pendingApprovals: [...s.pendingApprovals, approval],
    })),

  removeApproval: (approvalId) =>
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((a) => a.approval_id !== approvalId),
    })),

  handleEvent: (event) => {
    set((s) => {
      switch (event.type) {
        case "approval.requested":
          return {
            pendingApprovals: [...s.pendingApprovals, event.data as ApprovalRequest],
          };
        case "approval.responded":
        case "approval.timeout":
          return {
            pendingApprovals: s.pendingApprovals.filter(
              (a) => a.approval_id !== event.data.approval_id
            ),
          };
        default:
          return {};
      }
    });
  },
}));
