import type { ResearchDomain } from "@odft/contracts";

/**
 * Phase 11 affected-domain computation for selective changes
 * (03-langgraph-design.md section 10).
 *
 * The research fan-out still re-derives its dispatch from per-domain input
 * fingerprints; this module names the *targeted* subset a single accepted change
 * may refresh, so a dinner override can never rerun breakfast/lunch and a pace
 * change reruns nothing at all.
 */

/** Changes whose research/planning impact the invalidation matrix defines. */
export type InvalidationChange =
  | { readonly kind: "hotel_level" }
  | { readonly kind: "meal_level"; readonly meal: "breakfast" | "lunch" | "dinner" }
  | { readonly kind: "global_service_level" }
  | { readonly kind: "activity_pace" }
  | { readonly kind: "interests" }
  | { readonly kind: "activity_requirement" }
  | { readonly kind: "budget" }
  | { readonly kind: "selected_hotel_replacement" }
  | { readonly kind: "selected_meal_replacement"; readonly meal: "breakfast" | "lunch" | "dinner" }
  | { readonly kind: "flight_combination_change" }
  | { readonly kind: "route_change" }
  | {
      readonly kind: "search_alternatives";
      readonly target: "hotel" | "breakfast" | "lunch" | "dinner" | "activities";
    }
  | { readonly kind: "provider_fault"; readonly domain: ResearchDomain }
  /** A demo/retry control: it re-opens the current step, it changes no domain. */
  | { readonly kind: "control" }
  | { readonly kind: "none" };

export type ItineraryAction = "none" | "validate" | "propose";

export interface InvalidationRefs {
  /** Effective service levels plus which services have an explicit override. */
  readonly inheritedServices: readonly ("hotel" | "breakfast" | "lunch" | "dinner")[];
  readonly confirmedServices: readonly string[];
  readonly selectedServices: readonly string[];
  readonly hasConfirmedFlight: boolean;
  readonly programApplied: boolean;
}

export interface InvalidationResolution {
  /** Domains whose recommendations must be refreshed (`R`). */
  readonly affectedDomains: readonly ResearchDomain[];
  /** Domains whose content must be preserved exactly (`-`). */
  readonly preservedDomains: readonly ResearchDomain[];
  /** Itinerary consequence: none, logistics validation (`V`), or a new proposal (`P`). */
  readonly itineraryAction: ItineraryAction;
  /** `X`: explicit impact confirmation is required before booked state changes. */
  readonly requiresConfirmation: boolean;
  /** The change alters the route, so Stage A and Stage B must re-run. */
  readonly routeChange: boolean;
  /** The decision the refreshed work presents, when it presents one. */
  readonly nextDecisionKind:
    | "hotel_choice"
    | "program_choices"
    | "flight_choice"
    | "route_change_confirmation"
    | null;
  /**
   * True when the refreshed work re-opens the progress-derived decision step
   * (the existing hotel/program re-derivation), instead of a decision this
   * change chooses explicitly.
   */
  readonly progressDecision: boolean;
}

const ALL_RESEARCH_DOMAINS: readonly ResearchDomain[] = [
  "hotel",
  "breakfast",
  "lunch",
  "dinner",
  "attractions",
  "events",
];

function preservedExcept(affected: readonly ResearchDomain[]): ResearchDomain[] {
  const refreshed = new Set(affected);
  return ALL_RESEARCH_DOMAINS.filter((domain) => !refreshed.has(domain));
}

/** The research domains a change targets (`R` cells of the matrix). */
export function researchDomainsForChange(
  change: InvalidationChange,
  refs: InvalidationRefs,
): ResearchDomain[] {
  switch (change.kind) {
    case "hotel_level":
      return ["hotel"];
    case "meal_level":
      return [change.meal];
    case "global_service_level":
      // Only services that INHERIT the global default refresh; an explicit
      // override keeps its own category and its cached result.
      return [...refs.inheritedServices];
    case "activity_pace":
      // Reuse the existing candidate inventory; the itinerary is rebuilt.
      return [];
    case "interests":
    case "activity_requirement":
      return ["attractions"];
    case "budget":
      // Cheaper/free alternatives may be suggested, never auto-replaced.
      return refs.programApplied ? ["attractions"] : [];
    case "selected_hotel_replacement":
      return ["hotel"];
    case "selected_meal_replacement":
      return [change.meal];
    case "flight_combination_change":
      return [];
    case "route_change":
      // The extended snapshot decides which domains actually changed; the
      // fingerprint diff handles that, so no targeted subset is forced.
      return [];
    case "search_alternatives":
      return change.target === "activities" ? ["attractions"] : [change.target];
    case "provider_fault":
      return [change.domain];
    case "control":
    case "none":
      return [];
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

/**
 * Exact matrix resolution (03 section 10). `R` refreshes recommendations only,
 * `V` validates dependent logistics, `P` creates a new itinerary proposal, `X`
 * requires explicit impact confirmation before incompatible booked state
 * changes, and `-` preserves the domain and its content hash.
 */
export function resolveInvalidation(
  change: InvalidationChange,
  refs: InvalidationRefs,
): InvalidationResolution {
  const affectedDomains = researchDomainsForChange(change, refs);
  const preservedDomains = preservedExcept(affectedDomains);
  const hasBooked = refs.confirmedServices.length > 0;
  /** Re-open the existing progress-derived decision step (hotel/program). */
  const progressDecision = (): InvalidationResolution => ({
    affectedDomains,
    preservedDomains,
    itineraryAction: "none",
    requiresConfirmation: false,
    routeChange: false,
    nextDecisionKind: null,
    progressDecision: true,
  });

  switch (change.kind) {
    case "hotel_level":
      // R; the booking stays active. The itinerary changes only after a
      // confirmed replacement (the replacement flow handles that).
      return progressDecision();
    case "meal_level":
      return progressDecision();
    case "global_service_level":
      // R for inherited services only; an explicit override keeps its category.
      return progressDecision();
    case "activity_pace":
      // Reuse the candidate inventory; an APPLIED program stays authoritative
      // (pace only changes durations, not the chosen meals/activities), so the
      // itinerary is rebuilt directly instead of asking the user to re-confirm
      // the program (2026-10-13). Before a program exists the step still
      // re-derives through progress.
      return refs.programApplied
        ? {
            affectedDomains,
            preservedDomains,
            itineraryAction: "propose",
            requiresConfirmation: false,
            routeChange: false,
            nextDecisionKind: null,
            progressDecision: false,
          }
        : {
            ...progressDecision(),
            itineraryAction: "propose",
          };
    case "interests":
    case "activity_requirement":
      // With an APPLIED program the activity preferences stay authoritative: the
      // affected attractions are refreshed and the itinerary is rebuilt directly
      // (research then plan) instead of asking the user to re-confirm the
      // program (2026-10-14, product decision). Before a program exists the step
      // still re-derives through progress.
      return refs.programApplied
        ? {
            affectedDomains,
            preservedDomains,
            itineraryAction: "propose",
            requiresConfirmation: false,
            routeChange: false,
            nextDecisionKind: null,
            progressDecision: false,
          }
        : {
            ...progressDecision(),
            itineraryAction: "propose",
          };
    case "budget":
      return {
        ...progressDecision(),
        itineraryAction: refs.programApplied ? "propose" : "validate",
      };
    case "selected_hotel_replacement":
      return {
        affectedDomains,
        preservedDomains,
        itineraryAction: "propose",
        requiresConfirmation: hasBooked,
        routeChange: false,
        nextDecisionKind: "hotel_choice",
        progressDecision: false,
      };
    case "selected_meal_replacement":
      return {
        affectedDomains,
        preservedDomains,
        itineraryAction: "propose",
        requiresConfirmation: hasBooked,
        routeChange: false,
        nextDecisionKind: "program_choices",
        progressDecision: false,
      };
    case "flight_combination_change":
      return {
        affectedDomains,
        preservedDomains,
        itineraryAction: "propose",
        requiresConfirmation: hasBooked,
        routeChange: false,
        nextDecisionKind: "flight_choice",
        progressDecision: false,
      };
    case "route_change":
      // Without a confirmed reservation there is nothing to cancel, so the route
      // applies directly and only the fresh feasibility stages run. With a
      // booking the impact confirmation must be presented first.
      return {
        affectedDomains,
        preservedDomains,
        itineraryAction: "propose",
        requiresConfirmation: hasBooked,
        routeChange: true,
        nextDecisionKind: hasBooked ? "route_change_confirmation" : null,
        progressDecision: false,
      };
    case "search_alternatives":
      return {
        affectedDomains,
        preservedDomains,
        itineraryAction: "none",
        requiresConfirmation: false,
        routeChange: false,
        // A hotel search presents hotel alternatives; a meal/activity search
        // presents the program choices with the refreshed offers.
        nextDecisionKind: change.target === "hotel" ? "hotel_choice" : "program_choices",
        progressDecision: false,
      };
    case "provider_fault":
      return {
        affectedDomains,
        preservedDomains,
        itineraryAction: "none",
        requiresConfirmation: false,
        routeChange: false,
        nextDecisionKind: null,
        progressDecision: false,
      };
    case "control":
      // Overlay/retry controls never end the trip: the current step re-derives.
      return progressDecision();
    case "none":
      return {
        affectedDomains,
        preservedDomains,
        itineraryAction: "none",
        requiresConfirmation: false,
        routeChange: false,
        nextDecisionKind: null,
        progressDecision: false,
      };
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}
