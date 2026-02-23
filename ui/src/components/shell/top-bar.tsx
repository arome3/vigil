"use client";

import Link from "next/link";
import { Shield, Search, Bell } from "lucide-react";
import { NavTabs } from "./nav-tabs";
import { ConnectionStatus } from "./connection-status";
import { useUIStore } from "@/stores/ui-store";
import { useApprovalStore } from "@/stores/approval-store";

export function TopBar() {
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const pendingCount = useApprovalStore((s) => s.pendingApprovals.length);

  return (
    <header className="fixed top-0 left-0 right-0 z-40 hidden md:flex items-center justify-between h-12 px-4 border-b border-border-subtle bg-surface-base/95 backdrop-blur-sm">
      {/* Left — Logo */}
      <Link href="/" className="flex items-center gap-2 shrink-0" aria-label="Vigil home">
        <Shield className="h-5 w-5 text-info" />
        <span className="text-sm font-bold tracking-wider text-foreground">VIGIL</span>
      </Link>

      {/* Center — Navigation */}
      <NavTabs />

      {/* Right — Actions */}
      <div className="flex items-center gap-1">
        {/* Search trigger */}
        <button
          onClick={() => setCommandPaletteOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground rounded-md border border-border-subtle hover:bg-accent/50 transition-colors"
          aria-label="Open command palette (Cmd+K)"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">Search...</span>
          <kbd className="hidden lg:inline-flex h-5 items-center gap-0.5 rounded border border-border-subtle bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
            <span className="text-xs">&#8984;</span>K
          </kbd>
        </button>

        {/* Notification bell */}
        <button
          className="relative flex items-center justify-center h-8 w-8 rounded-md hover:bg-accent/50 transition-colors"
          aria-label={`Notifications${pendingCount > 0 ? `, ${pendingCount} pending` : ""}`}
        >
          <Bell className="h-4 w-4 text-muted-foreground" />
          {pendingCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-error text-[10px] font-bold text-white">
              {pendingCount}
            </span>
          )}
        </button>

        {/* Connection status */}
        <ConnectionStatus />
      </div>
    </header>
  );
}
