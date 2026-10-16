"use client";

import { useMemo } from "react";
import type { GraphDefinition, PublicInspectorNode } from "@odft/contracts";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "./execution-graph-layout";

/**
 * Phase 11 execution graph (08-frontend-ux.md section 10).
 *
 * Renders the ACTUAL node/edge topology the worker persisted via
 * `graph.initialized`, colored by the real node-event status. It is decorative:
 * the node table below carries the same facts as text, and the SVG is marked
 * `aria-hidden`.
 */

const STATUS_FILL: Readonly<Record<PublicInspectorNode["status"], string>> = {
  pending: "#f5f0e6",
  active: "#fde68a",
  completed: "#ccfbf1",
  interrupted: "#bae6fd",
  failed: "#fecaca",
};

const STATUS_STROKE: Readonly<Record<PublicInspectorNode["status"], string>> = {
  pending: "#c9c2b4",
  active: "#b45309",
  completed: "#0f766e",
  interrupted: "#0369a1",
  failed: "#b91c1c",
};

export function ExecutionGraph({
  definition,
  nodes,
}: {
  readonly definition: GraphDefinition;
  readonly nodes: readonly PublicInspectorNode[];
}): React.JSX.Element {
  const statusByName = useMemo(
    () => new Map(nodes.map((node) => [node.name, node.status])),
    [nodes],
  );
  const layout = useMemo(() => layoutGraph(definition, statusByName), [definition, statusByName]);
  return (
    <div className="overflow-x-auto rounded border border-border bg-cream p-2">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={`Execution graph with ${layout.nodes.length} nodes`}
        data-testid="execution-graph"
      >
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#8a8172" />
          </marker>
        </defs>
        {layout.edges.map((edge, index) => {
          const x1 = edge.from.x + NODE_WIDTH;
          const y1 = edge.from.y + NODE_HEIGHT / 2;
          const x2 = edge.to.x;
          const y2 = edge.to.y + NODE_HEIGHT / 2;
          const midX = (x1 + x2) / 2;
          return (
            <path
              key={`${edge.from.id}->${edge.to.id}-${index}`}
              d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="#8a8172"
              strokeWidth="1"
              markerEnd="url(#arrow)"
            />
          );
        })}
        {layout.nodes.map((node) => (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={4}
              fill={STATUS_FILL[node.status]}
              stroke={STATUS_STROKE[node.status]}
              strokeWidth="1.5"
            />
            <text x={node.x + 8} y={node.y + 19} fontSize="11" fill="#1f2937">
              {node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
