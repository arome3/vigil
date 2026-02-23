"use client";

import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";

interface CytoscapeRendererProps {
  elements: Array<{
    data: Record<string, unknown>;
    group?: "nodes" | "edges";
  }>;
}

export default function CytoscapeRenderer({ elements }: CytoscapeRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: elements as cytoscape.ElementDefinition[],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)" as unknown as string,
            label: "data(label)" as unknown as string,
            color: "#F1F5F9",
            "text-valign": "bottom",
            "text-margin-y": 6,
            "font-size": "10px",
            "font-family": "Inter, sans-serif",
            width: 32,
            height: 32,
            "border-width": 2,
            "border-color": "data(color)" as unknown as string,
            "background-opacity": 0.2,
          },
        },
        {
          selector: "node[type='external']",
          style: {
            "border-style": "dashed",
          },
        },
        {
          selector: "node[shape='round-rectangle']",
          style: {
            shape: "round-rectangle",
          },
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#475569",
            "target-arrow-color": "#475569",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)" as unknown as string,
            color: "#94A3B8",
            "font-size": "8px",
            "text-background-color": "#0F172A",
            "text-background-opacity": 0.8,
          } as cytoscape.Css.Edge,
        },
      ],
      layout: {
        name: "breadthfirst",
        directed: true,
        padding: 20,
        spacingFactor: 1.5,
      },
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    });

    cyRef.current = cy;
    return () => cy.destroy();
  }, [elements]);

  return <div ref={containerRef} className="w-full h-full" />;
}
