import type { DomainCommand, TripPreferences } from "@odft/contracts";
import {
  resolveInvalidation,
  type InvalidationChange,
  type InvalidationRefs,
  type InvalidationResolution,
} from "@odft/domain";

/**
 * Phase 11 invalidation-matrix dispatch (03-langgraph-design.md section 10).
 *
 * Maps an accepted command batch to the exact matrix actions per affected
 * domain and to the next work item the graph must run. This is the single
 * place that decides "research, replan, re-validate, ask for confirmation, or
 * just continue" — nodes never re-derive it from wording.
 */

/** The work item a routing decision hands to the graph. */
export type NextWork =
  | "none"
  | "route"
  | "research"
  | "progress"
  | "plan"
  | "validate"
  | "summary"
  | "decision";

export interface RoutingRefsInput {
  readonly preferences: Pick<TripPreferences, "defaultServiceLevel" | "serviceOverrides">;
  readonly confirmedServices: readonly string[];
  readonly selectedServices: readonly string[];
  readonly hasConfirmedFlight: boolean;
  readonly programApplied: boolean;
}

export function routingRefs(input: RoutingRefsInput): InvalidationRefs {
  const inheritedServices = (
    ["hotel", "breakfast", "lunch", "dinner"] as const
  ).filter((service) => input.preferences.serviceOverrides[service] === undefined);
  return {
    inheritedServices,
    confirmedServices: input.confirmedServices,
    selectedServices: input.selectedServices,
    hasConfirmedFlight: input.hasConfirmedFlight,
    programApplied: input.programApplied,
  };
}

/** Matrix row for one command; a batch resolves each command and merges. */
export function commandChange(command: DomainCommand): InvalidationChange {
  switch (command.type) {
    case "set_route":
      return { kind: "route_change" };
    case "set_default_service_level":
      return { kind: "global_service_level" };
    case "set_service_override":
      return command.service === "hotel"
        ? { kind: "hotel_level" }
        : { kind: "meal_level", meal: command.service };
    case "set_activity_pace":
      return { kind: "activity_pace" };
    case "set_interests":
      return { kind: "interests" };
    case "set_activity_requirement":
      return { kind: "activity_requirement" };
    case "set_budget":
      return { kind: "budget" };
    case "find_alternatives":
      return { kind: "search_alternatives", target: command.target };
    case "propose_selection":
      if (command.service === "hotel") {
        return { kind: "selected_hotel_replacement" };
      }
      if (command.service === "flights") {
        return { kind: "flight_combination_change" };
      }
      return { kind: "selected_meal_replacement", meal: command.service };
    case "set_simulation":
    case "retry_failed_domains":
      return { kind: "control" };
    case "set_program":
    case "build_itinerary":
      return { kind: "none" };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

const DECISION_PRECEDENCE = {
  route_change_confirmation: 5,
  hotel_choice: 4,
  program_choices: 3,
  flight_choice: 2,
} as const;

const ITINERARY_PRECEDENCE = { none: 0, validate: 1, propose: 2 } as const;

function decisionRank(kind: InvalidationResolution["nextDecisionKind"]): number {
  return kind === null ? 0 : DECISION_PRECEDENCE[kind];
}

function strongestItineraryAction(
  actions: readonly InvalidationResolution["itineraryAction"][],
): InvalidationResolution["itineraryAction"] {
  let best: InvalidationResolution["itineraryAction"] = "none";
  for (const action of actions) {
    if (ITINERARY_PRECEDENCE[action] > ITINERARY_PRECEDENCE[best]) {
      best = action;
    }
  }
  return best;
}

/**
 * Merge the per-command resolutions of one admitted batch into the batch-level
 * resolution: the union of affected domains, the strongest itinerary action, an
 * explicit confirmation if any command needs one, and the highest-precedence
 * decision to present.
 */
export function mergeResolutions(
  resolutions: readonly InvalidationResolution[],
): InvalidationResolution {
  const affectedDomains = resolutions
    .flatMap((resolution) => resolution.affectedDomains)
    .filter((domain, index, all) => all.indexOf(domain) === index);
  const affected = new Set<string>(affectedDomains);
  const allDomains = [
    "hotel",
    "breakfast",
    "lunch",
    "dinner",
    "attractions",
    "events",
  ] as const;
  const nextDecisionKind =
    resolutions
      .map((resolution) => resolution.nextDecisionKind)
      .sort((a, b) => decisionRank(b) - decisionRank(a))[0] ?? null;
  return {
    affectedDomains,
    preservedDomains: allDomains.filter((domain) => !affected.has(domain)),
    itineraryAction: strongestItineraryAction(
      resolutions.map((resolution) => resolution.itineraryAction),
    ),
    requiresConfirmation: resolutions.some((resolution) => resolution.requiresConfirmation),
    routeChange: resolutions.some((resolution) => resolution.routeChange),
    nextDecisionKind,
    // A batch keeps the progress-derived step only when no command chose a
    // decision of its own.
    progressDecision:
      nextDecisionKind === null && resolutions.some((resolution) => resolution.progressDecision),
  };
}

export interface ResolvedCommandRouting {
  readonly changes: readonly InvalidationChange[];
  readonly resolution: InvalidationResolution;
  readonly nextWork: NextWork;
}

/** Resolve a whole admitted command batch to the next work item. */
export function resolveCommandRouting(input: {
  readonly commands: readonly DomainCommand[];
  readonly refs: InvalidationRefs;
}): ResolvedCommandRouting {
  const changes = input.commands.map(commandChange);
  const resolutions = changes.map((change) => resolveInvalidation(change, input.refs));
  const resolution = mergeResolutions(resolutions);
  // An empty batch (e.g. the "keep the budget" clarification option) changes
  // nothing and must re-open the current step instead of ending the run.
  if (input.commands.length === 0) {
    return {
      changes,
      resolution: { ...resolution, progressDecision: true },
      nextWork: "progress",
    };
  }
  return { changes, resolution, nextWork: nextWorkFor(resolution) };
}

/**
 * The work item for a resolution: a confirmation decision routes through the
 * fresh route feasibility stages; targeted research runs before anything that
 * depends on refreshed recommendations; a plan-only change (pace/interests)
 * replans directly; otherwise the run simply continues to the summary.
 */
export function nextWorkFor(resolution: InvalidationResolution): NextWork {
  if (resolution.routeChange) {
    // A route change always re-runs Stage A and Stage B; a confirmation (booked
    // trips only) is presented first.
    return "route";
  }
  if (resolution.nextDecisionKind === "route_change_confirmation") {
    return "route";
  }
  if (resolution.nextDecisionKind !== null) {
    // A targeted search/replacement presents its own refreshed decision.
    return "research";
  }
  if (resolution.progressDecision) {
    // Preference/control changes re-open the current step through progress
    // detection; the fingerprint dispatch still refreshes only affected domains.
    return "progress";
  }
  if (resolution.affectedDomains.length > 0) {
    return "research";
  }
  if (resolution.itineraryAction === "propose") {
    return "plan";
  }
  if (resolution.itineraryAction === "validate") {
    return "validate";
  }
  return "summary";
}
