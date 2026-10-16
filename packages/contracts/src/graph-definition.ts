import { z } from "zod";

/**
 * Safe, versioned graph-definition DTO (08-frontend-ux.md section 10, Phase 11).
 *
 * The worker emits this definition from the SAME node/edge registry used to
 * build the compiled graph, so the inspector can render an actual node/edge
 * diagram without ever calling a graph API from the BFF or the browser. It
 * carries no handlers, prompts, or code — only labels and topology.
 */

export const graphNodeKindSchema = z.enum(["entry", "serial", "parallel", "decision", "terminal"]);
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;

export const graphDefinitionNodeSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    kind: graphNodeKindSchema,
  })
  .strict();
export type GraphDefinitionNode = z.infer<typeof graphDefinitionNodeSchema>;

export const graphDefinitionEdgeSchema = z
  .object({
    from: z.string().min(1).max(80),
    to: z.string().min(1).max(80),
    label: z.string().min(1).max(120).nullable(),
    conditional: z.boolean(),
  })
  .strict();
export type GraphDefinitionEdge = z.infer<typeof graphDefinitionEdgeSchema>;

export const graphDefinitionSchema = z
  .object({
    graphVersion: z.string().min(1).max(80),
    nodes: z.array(graphDefinitionNodeSchema).min(1).max(64),
    edges: z.array(graphDefinitionEdgeSchema).min(1).max(128),
  })
  .strict();
export type GraphDefinition = z.infer<typeof graphDefinitionSchema>;
