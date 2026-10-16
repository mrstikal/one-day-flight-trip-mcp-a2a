import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { TRAVEL_GRAPH_VERSION, travelStateSchema, type TravelState, type TravelUpdate } from "./state.js";
import { routeByNextWork, routeForCommandType } from "../routing/next-work-target.js";
import {
  TRAVEL_GRAPH_EDGE_GROUPS,
  TRAVEL_GRAPH_NODES,
  type TravelGraphNodeSpec,
} from "./graph-definition.js";
import { loadContextNode } from "../nodes/load-context.js";
import { applyCommandsNode } from "../nodes/apply-commands.js";
import { validateRouteNode } from "../nodes/validate-route.js";
import { generateFlightsNode } from "../nodes/generate-flights.js";
import { validateSchedulesNode } from "../nodes/validate-schedules.js";
import { ensureDomainsNode } from "../nodes/ensure-domains.js";
import { dispatchResearchNode, routeAfterDispatch } from "../nodes/dispatch-research.js";
import { researchDomainNode } from "../nodes/research-domain.js";
import { joinResearchNode, routeAfterJoin } from "../nodes/join-research.js";
import { rankRecommendationsNode, routeAfterRank } from "../nodes/rank-recommendations.js";
import { validateSelectedLogisticsNode } from "../nodes/validate-selected-logistics.js";
import { detectProgressNode } from "../nodes/detect-progress.js";
import { prepareDecisionNode } from "../nodes/prepare-decision.js";
import { awaitDecisionNode } from "../nodes/await-decision.js";
import { applyDecisionNode } from "../nodes/apply-decision.js";
import { stageSelectionNode } from "../nodes/stage-selection.js";
import { stageCommandProposalNode } from "../nodes/stage-command-proposal.js";
import { commitBookingNode } from "../nodes/commit-booking.js";
import { declineBookingNode } from "../nodes/decline-booking.js";
import { commitRouteChangeNode } from "../nodes/commit-route-change.js";
import { applyProgramNode } from "../nodes/apply-program.js";
import {
  interpretIntentNode,
  interpretModificationNode,
  resolveClarificationNode,
  routeAfterModification,
} from "../nodes/interpret-intent.js";
import { publishSummaryNode } from "../nodes/publish-summary.js";
import { planItineraryNode } from "../nodes/plan-itinerary.js";
import { validateItineraryNode } from "../nodes/validate-itinerary.js";
import { reviewItineraryNode } from "../nodes/review-itinerary.js";
import { approveItineraryNode } from "../nodes/approve-itinerary.js";

/**
 * Production travel graph (Phase 06-11).
 *
 * START -> load_context -> apply_commands ->
 *   propose_selection -> stage_command_proposal -> prepare_decision
 *   set_route with confirmed reservations -> prepare_decision
 *     (route_change_confirmation) -> await_decision -> apply_decision ->
 *       confirm_route_change -> commit_route_change -> validate_route
 *   build_itinerary -> plan_itinerary
 *   else -> next-work dispatch (invalidation matrix, Phase 11):
 *     research -> (flight confirmed) ensure_domains -> validate_schedules ->
 *         dispatch_research -> Send research_domain x N -> join_research -> ...
 *     research -> (no flight) validate_route -> ...
 *     plan -> plan_itinerary
 *     validate -> validate_selected_logistics
 *     summary -> publish_summary
 *   (generic fallback) detect_progress -> ...
 *
 * The topology is defined ONCE in `graph-definition.ts`; this module only binds
 * handlers and routers, so the persisted `graph.initialized` definition always
 * matches the compiled graph.
 */

export function routeAfterValidation(state: TravelState): string {
  return state.routeStatus === "FEASIBLE" ? "generate_flights" : "publish_summary";
}

export function routeAfterGeneration(state: TravelState): string {
  return state.snapshotId ? "validate_schedules" : "publish_summary";
}

export function routeAfterSchedules(state: TravelState): string {
  if (state.scheduleStatus !== "VALID") {
    return "publish_summary";
  }
  // After a domain extension the snapshot version changes, so the schedule
  // validation must be rebound before any non-flight confirmation.
  if (state.domainsEnsured && state.researchStatus === "pending") {
    return "dispatch_research";
  }
  return "prepare_decision";
}


/** A `propose_selection` command skips feasibility and opens a confirmation; a
 * `set_program` command applies the program directly; a chat request is
 * interpreted by the intent role first. Everything else routes by the
 * invalidation matrix (Phase 11) or falls back to progress detection. */
export function routeAfterApplyCommands(state: TravelState): string {
  if (state.commandType === "chat") {
    return "interpret_intent";
  }
  // A STAGED route change presents its impact confirmation; an applied
  // (unbooked) route change continues into fresh feasibility via `nextWork`.
  return routeForCommandType(state) ?? routeByNextWork(state) ?? "detect_progress";
}

/** Route a validated intent result: an unsupported modification re-presents the
 * decision it interrupted (the trip must never be left without one), plain
 * unsupported chats end, clarification interrupts, program/proposal commands
 * reuse their existing stages, and preference/search commands continue through
 * the invalidation-matrix dispatch. */
export function routeAfterIntentResult(state: TravelState): string {
  if (state.intentStatus === "unsupported") {
    return state.restoredDecision ? "prepare_decision" : "publish_summary";
  }
  if (state.intentStatus === "clarification") {
    return "prepare_decision";
  }
  return routeForCommandType(state) ?? routeByNextWork(state) ?? "detect_progress";
}

/** With a confirmed flight, re-derive the non-flight steps; otherwise run feasibility. */
export function routeAfterDetectProgress(state: TravelState): string {
  // A flight kept as a selection ("I don't want to book") also settles the
  // flight step: the trip continues to the extended snapshot instead of
  // re-running feasibility.
  return state.hasConfirmedFlight || state.selectedServices.includes("flights")
    ? "ensure_domains"
    : "validate_route";
}

export function routeAfterApplyDecision(state: TravelState): string {
  switch (state.pendingStage) {
    case "stage":
      return "stage_selection";
    case "commit":
      return "commit_booking";
    case "decline":
      return "decline_booking";
    case "commit_route":
      return "commit_route_change";
    case "program":
      return "apply_program";
    case "approve":
      return "approve_itinerary";
    case "reselection":
      // Re-derive the affected offers through the research/ranking path instead
      // of preparing a decision from state that a fresh operation has cleared.
      return "detect_progress";
    case "clarification_apply":
      return "resolve_clarification";
    case "clarification_modify":
      return "interpret_modification";
    default:
      return "publish_summary";
  }
}

/** After a confirmed booking: flights continue to hotel research, others to logistics. */
export function routeAfterCommit(state: TravelState): string {
  if (state.bookingService !== "flights") {
    return "validate_selected_logistics";
  }
  // A null next decision means the trip is already planned: a late booking (from
  // the "Not booked" review) only replans through the logistics check, exactly
  // like a late meal reservation. The initial booking continues into research.
  return state.nextDecisionKind === null ? "validate_selected_logistics" : "ensure_domains";
}

/**
 * After a declined booking ("I don't want to book"): the same service-based
 * continuation as a booking, except that a decline during an already-planned
 * trip usually just keeps the selection and ends the run. A late declined
 * CHANGE (the declined offer differs from the kept selection) replans the day
 * through the logistics check instead, mirroring a late meal selection change.
 */
export function routeAfterDecline(state: TravelState): string {
  if (state.nextDecisionKind === null) {
    return state.declinedSelectionChanged ? "validate_selected_logistics" : "publish_summary";
  }
  return state.bookingService === "flights" ? "ensure_domains" : "validate_selected_logistics";
}

/** After materialization, revalidate Stage B against the extended snapshot. */
export function routeAfterEnsureDomains(): string {
  return "validate_schedules";
}

/** Program application always runs the deterministic logistics check next. */
export function routeAfterApplyProgram(): string {
  return "validate_selected_logistics";
}

export function routeAfterLogistics(state: TravelState): string {
  if (state.logisticsStatus === "conflict") {
    return "prepare_decision";
  }
  if (
    state.nextDecisionKind === "program_choices" ||
    state.nextDecisionKind === "replacement_confirmation" ||
    state.nextDecisionKind === "recovery"
  ) {
    return "prepare_decision";
  }
  // Phase 10: a valid program/logistics state always (re)builds the itinerary.
  return "plan_itinerary";
}

/**
 * Phase 10 bounded planning loop. Budget conflicts stop the loop immediately;
 * other invalid results replan while attempts remain (max three total) and then
 * open the conflict decision; a valid result continues to review.
 */
export function routeAfterValidateItinerary(state: TravelState): string {
  if (state.itineraryValidationStatus === "valid") {
    return "review_itinerary";
  }
  if (state.itineraryBudgetConflict) {
    return "prepare_decision";
  }
  if (state.planningAttempt < 3) {
    return "plan_itinerary";
  }
  return "prepare_decision";
}

/** A `revise` verdict replans while attempts remain; otherwise the approval (or
 * the review-conflict decision) opens. */
export function routeAfterReviewItinerary(state: TravelState): string {
  if (state.itineraryReviewVerdict === "revise" && state.planningAttempt < 3) {
    return "plan_itinerary";
  }
  return "prepare_decision";
}

export interface BuildTravelGraphOptions {
  readonly checkpointer: BaseCheckpointSaver;
}

type NodeHandler = (state: TravelState, runtime: unknown) => TravelUpdate | Promise<TravelUpdate>;
type Router = (state: TravelState) => string | unknown;

const NODE_HANDLERS: Readonly<Record<string, NodeHandler>> = {
  load_context: loadContextNode,
  apply_commands: applyCommandsNode,
  interpret_intent: interpretIntentNode,
  resolve_clarification: resolveClarificationNode,
  interpret_modification: interpretModificationNode,
  detect_progress: detectProgressNode,
  validate_route: validateRouteNode,
  generate_flights: generateFlightsNode,
  validate_schedules: validateSchedulesNode,
  ensure_domains: ensureDomainsNode,
  dispatch_research: dispatchResearchNode,
  research_domain: researchDomainNode,
  join_research: joinResearchNode,
  rank_recommendations: rankRecommendationsNode,
  validate_selected_logistics: validateSelectedLogisticsNode,
  plan_itinerary: planItineraryNode,
  validate_itinerary: validateItineraryNode,
  review_itinerary: reviewItineraryNode,
  approve_itinerary: approveItineraryNode,
  prepare_decision: prepareDecisionNode,
  await_decision: awaitDecisionNode,
  apply_decision: applyDecisionNode,
  stage_command_proposal: stageCommandProposalNode,
  stage_selection: stageSelectionNode,
  commit_booking: commitBookingNode,
  decline_booking: declineBookingNode,
  commit_route_change: commitRouteChangeNode,
  apply_program: applyProgramNode,
  publish_summary: publishSummaryNode,
};

const ROUTERS: Readonly<Record<string, Router>> = {
  apply_commands: routeAfterApplyCommands,
  interpret_modification: routeAfterModification,
  interpret_intent: routeAfterIntentResult,
  resolve_clarification: routeAfterIntentResult,
  detect_progress: routeAfterDetectProgress,
  validate_route: routeAfterValidation,
  generate_flights: routeAfterGeneration,
  validate_schedules: routeAfterSchedules,
  apply_decision: routeAfterApplyDecision,
  commit_booking: routeAfterCommit,
  decline_booking: routeAfterDecline,
  dispatch_research: routeAfterDispatch,
  join_research: routeAfterJoin,
  rank_recommendations: routeAfterRank,
  validate_selected_logistics: routeAfterLogistics,
  validate_itinerary: routeAfterValidateItinerary,
  review_itinerary: routeAfterReviewItinerary,
};

function handlerFor(node: TravelGraphNodeSpec): NodeHandler {
  const handler = NODE_HANDLERS[node.id];
  if (!handler) {
    throw new Error(`travel graph registry has no handler for node ${node.id}`);
  }
  return handler;
}

export function buildTravelGraph(options: BuildTravelGraphOptions) {
  const builder = new StateGraph(travelStateSchema);
  for (const node of TRAVEL_GRAPH_NODES) {
    // The registry guarantees valid ids; the builder's generic overloads cannot
    // express a runtime registry, so the calls are narrowed at this boundary.
    builder.addNode(node.id as never, handlerFor(node) as never);
  }
  for (const group of TRAVEL_GRAPH_EDGE_GROUPS) {
    const from = (group.from === "__start__" ? START : group.from) as never;
    if (!group.conditional) {
      const target = group.targets[0];
      if (!target) {
        throw new Error(`travel graph edge group from ${group.from} has no target`);
      }
      builder.addEdge(from, (target === "__end__" ? END : target) as never);
      continue;
    }
    const router = ROUTERS[group.from];
    if (!router) {
      throw new Error(`travel graph registry has no router for node ${group.from}`);
    }
    if (group.dynamic) {
      // The router itself returns `Send[]`; no static target list is bound.
      builder.addConditionalEdges(from, router as never);
    } else {
      builder.addConditionalEdges(from, router as never, [...group.targets] as never);
    }
  }
  return builder.compile({ checkpointer: options.checkpointer });
}

export { TRAVEL_GRAPH_VERSION };
export { routeAfterDispatch, routeAfterJoin, routeAfterRank };
