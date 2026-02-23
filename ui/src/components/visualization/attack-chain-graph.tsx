"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const CytoscapeRenderer = dynamic(() => import("./cytoscape-renderer"), { ssr: false });

interface AttackChainGraphProps {
  elements: Array<{
    data: Record<string, unknown>;
    group?: "nodes" | "edges";
  }>;
}

export function AttackChainGraph({ elements }: AttackChainGraphProps) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 768px)");
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  if (isMobile) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Attack Chain</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {elements
              .filter((el) => el.data && "source" in el.data)
              .map((edge, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="font-mono">{String(edge.data.source)}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-mono">{String(edge.data.target)}</span>
                  {Boolean(edge.data.label) && (
                    <span className="text-muted-foreground">({String(edge.data.label)})</span>
                  )}
                </div>
              ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Attack Chain</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-72 border border-border-subtle rounded-lg overflow-hidden">
          <CytoscapeRenderer elements={elements} />
        </div>
      </CardContent>
    </Card>
  );
}
