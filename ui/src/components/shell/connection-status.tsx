"use client";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useConnectionStore } from "@/stores/connection-store";

export function ConnectionStatus() {
  const { status, latencyMs, lastEventTime, reconnectAttempts } = useConnectionStore();

  const dotColor =
    status === "connected"
      ? "bg-success"
      : status === "reconnecting"
        ? "bg-warning animate-connection-pulse"
        : "bg-error";

  const label =
    status === "connected"
      ? "Connected"
      : status === "reconnecting"
        ? "Reconnecting..."
        : "Disconnected";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-accent/50 transition-colors"
          aria-label={`Connection status: ${label}`}
        >
          <span className={cn("h-2 w-2 rounded-full", dotColor)} />
          <span className="hidden lg:inline text-xs text-muted-foreground">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end">
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium">{label}</span>
          </div>
          {latencyMs !== null && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Latency</span>
              <span className="font-mono text-xs">{latencyMs}ms</span>
            </div>
          )}
          {lastEventTime && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last event</span>
              <span className="font-mono text-xs">{new Date(lastEventTime).toLocaleTimeString()}</span>
            </div>
          )}
          {reconnectAttempts > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reconnects</span>
              <span className="font-mono text-xs">{reconnectAttempts}</span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
