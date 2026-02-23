"use client";

import { type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWebSocket } from "@/hooks/use-websocket";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { CommandPalette } from "@/components/overlays/command-palette";
import { KeyboardShortcutOverlay } from "@/components/overlays/keyboard-shortcut-overlay";

function WebSocketInit() {
  useWebSocket();
  return null;
}

function KeyboardInit() {
  useKeyboardShortcuts();
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <WebSocketInit />
      <KeyboardInit />
      {children}
      <CommandPalette />
      <KeyboardShortcutOverlay />
      <Toaster
        position="top-right"
        toastOptions={{
          className: "border-border-subtle bg-surface-raised text-foreground",
        }}
      />
    </TooltipProvider>
  );
}
