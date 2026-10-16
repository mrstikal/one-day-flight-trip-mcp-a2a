import { describe, expect, it } from "vitest";
import type { GraphDefinition } from "@odft/contracts";
import { TRAVEL_GRAPH_DEFINITION } from "@odft/workflow";
import { layoutGraph } from "../../apps/web/src/components/inspector/execution-graph-layout.js";

const NODE_WIDTH = 150;
const NODE_HEIGHT = 30;

describe("execution graph layout", () => {
  it("starts the real travel graph at the left edge and clips no node", () => {
    const layout = layoutGraph(TRAVEL_GRAPH_DEFINITION, new Map());
    expect(layout.nodes.length).toBeGreaterThan(0);
    expect(Math.min(...layout.nodes.map((node) => node.x))).toBe(20);
    for (const node of layout.nodes) {
      expect(node.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(node.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });

  it("normalizes BFS depths that start at 1 instead of reserving an empty leading column", () => {
    const definition: GraphDefinition = {
      graphVersion: "test",
      nodes: [
        { id: "alpha", label: "Alpha", kind: "entry" },
        { id: "beta", label: "Beta", kind: "serial" },
        { id: "gamma", label: "Gamma", kind: "serial" },
      ],
      edges: [
        { from: "__start__", to: "alpha", label: null, conditional: false },
        { from: "alpha", to: "beta", label: null, conditional: false },
        { from: "alpha", to: "gamma", label: "alt", conditional: true },
      ],
    };
    const layout = layoutGraph(definition, new Map());
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(byId.get("alpha")?.x).toBe(20);
    expect(byId.get("beta")?.x).toBe(210);
    expect(byId.get("gamma")?.x).toBe(210);
    expect(layout.width).toBe(420);
  });
});
