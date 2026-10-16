import type { GraphDefinition, GraphNodeKind } from "@odft/contracts";
import { TRAVEL_GRAPH_VERSION } from "./state.js";

/**
 * Phase 11 graph registry (08-frontend-ux.md section 10).
 *
 * The SAME registry builds the compiled graph and the safe `graph.initialized`
 * definition the worker persists, so the inspector can never show a topology
 * the worker does not actually run. The definition carries labels only: no
 * handlers, no prompts, no code, no state.
 */

export interface TravelGraphNodeSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: GraphNodeKind;
}

export interface TravelGraphEdgeGroup {
  readonly from: string;
  readonly conditional: boolean;
  /** Static targets; a dynamic conditional edge (`Send`) declares its fan-out target. */
  readonly targets: readonly string[];
  readonly label: string | null;
  /** True when the router itself returns `Send[]` instead of a target name. */
  readonly dynamic?: boolean;
}

export const START_NODE_ID = "__start__";
export const END_NODE_ID = "__end__";

export const TRAVEL_GRAPH_NODES: readonly TravelGraphNodeSpec[] = [
  { id: "load_context", label: "Load context", kind: "serial" },
  { id: "apply_commands", label: "Apply commands", kind: "serial" },
  { id: "interpret_intent", label: "Interpret intent", kind: "decision" },
  { id: "resolve_clarification", label: "Resolve clarification", kind: "serial" },
  { id: "interpret_modification", label: "Interpret modification", kind: "serial" },
  { id: "detect_progress", label: "Detect progress", kind: "decision" },
  { id: "validate_route", label: "Validate route (Stage A)", kind: "decision" },
  { id: "generate_flights", label: "Generate flights", kind: "decision" },
  { id: "validate_schedules", label: "Validate schedules (Stage B)", kind: "decision" },
  { id: "ensure_domains", label: "Ensure domains", kind: "serial" },
  { id: "dispatch_research", label: "Dispatch research", kind: "decision" },
  { id: "research_domain", label: "Research domain (parallel)", kind: "parallel" },
  { id: "join_research", label: "Join research", kind: "decision" },
  { id: "rank_recommendations", label: "Rank recommendations", kind: "decision" },
  { id: "validate_selected_logistics", label: "Validate selected logistics", kind: "decision" },
  { id: "plan_itinerary", label: "Plan itinerary", kind: "serial" },
  { id: "validate_itinerary", label: "Validate itinerary", kind: "decision" },
  { id: "review_itinerary", label: "Review itinerary", kind: "decision" },
  { id: "approve_itinerary", label: "Approve itinerary", kind: "serial" },
  { id: "prepare_decision", label: "Prepare decision", kind: "serial" },
  { id: "await_decision", label: "Await decision (interrupt)", kind: "decision" },
  { id: "apply_decision", label: "Apply decision", kind: "serial" },
  { id: "stage_command_proposal", label: "Stage command proposal", kind: "serial" },
  { id: "stage_selection", label: "Stage selection", kind: "serial" },
  { id: "commit_booking", label: "Commit booking", kind: "decision" },
  { id: "decline_booking", label: "Decline booking (keep selection)", kind: "decision" },
  { id: "commit_route_change", label: "Commit route change", kind: "serial" },
  { id: "apply_program", label: "Apply program", kind: "decision" },
  { id: "publish_summary", label: "Publish summary", kind: "terminal" },
];

export const TRAVEL_GRAPH_EDGE_GROUPS: readonly TravelGraphEdgeGroup[] = [
  { from: START_NODE_ID, conditional: false, targets: ["load_context"], label: null },
  { from: "load_context", conditional: false, targets: ["apply_commands"], label: null },
  {
    from: "apply_commands",
    conditional: true,
    targets: [
      "interpret_intent",
      "stage_command_proposal",
      "apply_program",
      "plan_itinerary",
      "detect_progress",
      "ensure_domains",
      "validate_route",
      "validate_selected_logistics",
      "publish_summary",
      "prepare_decision",
    ],
    label: "command type / next work",
  },
  {
    from: "interpret_intent",
    conditional: true,
    targets: [
      "publish_summary",
      "prepare_decision",
      "apply_program",
      "stage_command_proposal",
      "plan_itinerary",
      "detect_progress",
      "ensure_domains",
      "validate_route",
      "validate_selected_logistics",
    ],
    label: "intent result",
  },
  {
    from: "resolve_clarification",
    conditional: true,
    targets: [
      "publish_summary",
      "prepare_decision",
      "apply_program",
      "stage_command_proposal",
      "plan_itinerary",
      "detect_progress",
      "ensure_domains",
      "validate_route",
      "validate_selected_logistics",
    ],
    label: "clarification commands",
  },
  {
    from: "interpret_modification",
    conditional: true,
    targets: [
      "interpret_intent",
      "prepare_decision",
      "apply_program",
      "stage_command_proposal",
      "plan_itinerary",
      "detect_progress",
      "ensure_domains",
      "validate_route",
      "validate_selected_logistics",
      "publish_summary",
    ],
    label: "chat or typed modification",
  },
  {
    from: "detect_progress",
    conditional: true,
    targets: ["ensure_domains", "validate_route"],
    label: "confirmed flight?",
  },
  {
    from: "validate_route",
    conditional: true,
    targets: ["generate_flights", "publish_summary"],
    label: "FEASIBLE?",
  },
  {
    from: "generate_flights",
    conditional: true,
    targets: ["validate_schedules", "publish_summary"],
    label: "snapshot?",
  },
  {
    from: "validate_schedules",
    conditional: true,
    targets: ["prepare_decision", "dispatch_research", "publish_summary"],
    label: "VALID?",
  },
  { from: "prepare_decision", conditional: false, targets: ["await_decision"], label: null },
  { from: "await_decision", conditional: false, targets: ["apply_decision"], label: null },
  {
    from: "apply_decision",
    conditional: true,
    targets: [
      "stage_selection",
      "commit_booking",
      "decline_booking",
      "commit_route_change",
      "apply_program",
      "approve_itinerary",
      "detect_progress",
      "prepare_decision",
      "resolve_clarification",
      "interpret_modification",
      "publish_summary",
    ],
    label: "resume action",
  },
  { from: "stage_command_proposal", conditional: false, targets: ["prepare_decision"], label: null },
  { from: "stage_selection", conditional: false, targets: ["prepare_decision"], label: null },
  {
    from: "commit_booking",
    conditional: true,
    targets: ["ensure_domains", "validate_selected_logistics"],
    label: "service",
  },
  {
    from: "decline_booking",
    conditional: true,
    targets: ["ensure_domains", "validate_selected_logistics", "publish_summary"],
    label: "service / late",
  },
  { from: "commit_route_change", conditional: false, targets: ["validate_route"], label: null },
  { from: "ensure_domains", conditional: false, targets: ["validate_schedules"], label: null },
  {
    from: "dispatch_research",
    conditional: true,
    targets: ["research_domain", "rank_recommendations"],
    label: "Send per affected domain",
    dynamic: true,
  },
  { from: "research_domain", conditional: false, targets: ["join_research"], label: null },
  {
    from: "join_research",
    conditional: true,
    targets: ["dispatch_research", "rank_recommendations", "prepare_decision"],
    label: "retry / gate",
  },
  {
    from: "rank_recommendations",
    conditional: true,
    targets: ["prepare_decision", "plan_itinerary", "publish_summary"],
    label: "decision target?",
  },
  {
    from: "apply_program",
    conditional: false,
    targets: ["validate_selected_logistics"],
    label: null,
  },
  {
    from: "validate_selected_logistics",
    conditional: true,
    targets: ["prepare_decision", "plan_itinerary"],
    label: "conflict?",
  },
  { from: "plan_itinerary", conditional: false, targets: ["validate_itinerary"], label: null },
  {
    from: "validate_itinerary",
    conditional: true,
    targets: ["review_itinerary", "plan_itinerary", "prepare_decision"],
    label: "valid / attempts",
  },
  {
    from: "review_itinerary",
    conditional: true,
    targets: ["plan_itinerary", "prepare_decision"],
    label: "revise?",
  },
  { from: "approve_itinerary", conditional: false, targets: ["publish_summary"], label: null },
  { from: "publish_summary", conditional: false, targets: [END_NODE_ID], label: null },
];

/** Safe graph-definition DTO derived from the same registry the builder uses. */
export const TRAVEL_GRAPH_DEFINITION: GraphDefinition = {
  graphVersion: TRAVEL_GRAPH_VERSION,
  nodes: TRAVEL_GRAPH_NODES.map((node) => ({ id: node.id, label: node.label, kind: node.kind })),
  edges: TRAVEL_GRAPH_EDGE_GROUPS.flatMap((group) =>
    group.targets.map((target) => ({
      from: group.from,
      to: target,
      label: group.label,
      conditional: group.conditional,
    })),
  ),
};

/** Label lookup used by the projection's node table. */
export const TRAVEL_NODE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  TRAVEL_GRAPH_NODES.map((node) => [node.id, node.label]),
);
