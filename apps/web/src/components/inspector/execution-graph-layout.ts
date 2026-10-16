import type { GraphDefinition, PublicInspectorNode } from "@odft/contracts";

/**
 * Pure layered-layout math for the Phase 11 execution graph
 * (08-frontend-ux.md section 10). Kept out of the JSX component so the
 * deterministic positioning is unit-testable without a DOM.
 */

export const COLUMN_WIDTH = 190;
export const ROW_HEIGHT = 44;
export const NODE_WIDTH = 150;
export const NODE_HEIGHT = 30;

interface Positioned {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly status: PublicInspectorNode["status"];
}

interface Layout {
  readonly nodes: Positioned[];
  readonly edges: readonly { from: Positioned; to: Positioned; label: string | null }[];
  readonly width: number;
  readonly height: number;
}

/** Deterministic layered layout: BFS depth from the entry; rows per column. */
export function layoutGraph(
  definition: GraphDefinition,
  statusByName: ReadonlyMap<string, PublicInspectorNode["status"]>,
): Layout {
  const outgoing = new Map<string, string[]>();
  for (const edge of definition.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const depth = new Map<string, number>();
  const queue: string[] = ["__start__"];
  depth.set("__start__", 0);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (next === "__end__" || depth.has(next)) {
        continue;
      }
      depth.set(next, (depth.get(current) ?? 0) + 1);
      queue.push(next);
    }
  }
  const columns = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const column = depth.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node.id]);
  }
  // `__start__`/`__end__` are not part of the persisted node list, so the BFS
  // depths start at 1: shift the used columns to start at 0, otherwise the
  // graph renders with a full empty leading column and the last column clips
  // outside the viewBox.
  const usedColumns = [...columns.keys()];
  const columnOffset = usedColumns.length > 0 ? Math.min(...usedColumns) : 0;
  const columnCount = usedColumns.length > 0 ? Math.max(...usedColumns) - columnOffset + 1 : 1;
  const positioned = new Map<string, Positioned>();
  let maxRows = 0;
  for (const [column, ids] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    ids.sort((a, b) => a.localeCompare(b));
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, rowIndex) => {
      const label = definition.nodes.find((node) => node.id === id)?.label ?? id;
      positioned.set(id, {
        id,
        label,
        x: 20 + (column - columnOffset) * COLUMN_WIDTH,
        y: 20 + rowIndex * ROW_HEIGHT,
        status: statusByName.get(id) ?? "pending",
      });
    });
  }
  const edges: { from: Positioned; to: Positioned; label: string | null }[] = [];
  for (const edge of definition.edges) {
    const from = positioned.get(edge.from);
    const to = positioned.get(edge.to);
    if (from && to) {
      edges.push({ from, to, label: edge.label });
    }
  }
  return {
    nodes: [...positioned.values()],
    edges,
    width: 40 + Math.max(1, columnCount) * COLUMN_WIDTH,
    height: 40 + Math.max(1, maxRows) * ROW_HEIGHT,
  };
}
