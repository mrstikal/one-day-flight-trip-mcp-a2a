import { z } from "zod";

/** Shared enums (04-domain-model.md section 2). */

export const travelVariantSchema = z.enum(["one_night", "two_nights"]);
export type TravelVariant = z.infer<typeof travelVariantSchema>;

export const serviceLevelSchema = z.enum(["budget", "standard", "luxury"]);
export type ServiceLevel = z.infer<typeof serviceLevelSchema>;

export const serviceKeySchema = z.enum(["hotel", "breakfast", "lunch", "dinner"]);
export type ServiceKey = z.infer<typeof serviceKeySchema>;

export const mealSchema = z.enum(["breakfast", "lunch", "dinner"]);
export type Meal = z.infer<typeof mealSchema>;

export const bookableKeySchema = z.enum(["flights", "hotel", "breakfast", "lunch", "dinner"]);
export type BookableKey = z.infer<typeof bookableKeySchema>;

export const preservableKeySchema = z.enum([
  "flights",
  "hotel",
  "breakfast",
  "lunch",
  "dinner",
  "activities",
  "events",
]);
export type PreservableKey = z.infer<typeof preservableKeySchema>;

export const activityPaceSchema = z.enum(["relaxed", "moderate", "intensive"]);
export type ActivityPace = z.infer<typeof activityPaceSchema>;

export const activityCategorySchema = z.enum(["culture", "relaxation", "entertainment"]);
export type ActivityCategory = z.infer<typeof activityCategorySchema>;

export const activityTagSchema = z.enum([
  "museum",
  "landmark",
  "gallery",
  "architecture",
  "park",
  "garden",
  "waterfront",
  "viewpoint",
  "performance",
]);
export type ActivityTag = z.infer<typeof activityTagSchema>;

export const workflowStatusSchema = z.enum([
  "idle",
  "queued",
  "running",
  "waiting_user",
  "blocked",
  "ready",
  "failed",
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

export const reservationStatusSchema = z.enum(["confirmed", "superseded", "cancelled"]);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

export const proposalStatusSchema = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "expired",
  "superseded",
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const operationStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OperationStatus = z.infer<typeof operationStatusSchema>;

export const decisionKindSchema = z.enum([
  "flight_choice",
  "hotel_choice",
  "program_choices",
  "booking_confirmation",
  "replacement_confirmation",
  "route_change_confirmation",
  "itinerary_approval",
  "clarification",
  "recovery",
]);
export type DecisionKind = z.infer<typeof decisionKindSchema>;

export const simulationModeSchema = z.enum([
  "normal",
  "no_flights",
  "hotels_unavailable",
  "provider_failure",
  "invalid_itinerary",
  "budget_conflict",
  "preference_conflict",
]);
export type SimulationMode = z.infer<typeof simulationModeSchema>;

export const routeReasonSchema = z.enum([
  "SAME_AIRPORT",
  "SAME_CATCHMENT",
  "GROUND_TRAVEL_PREFERRED",
  "NO_REFERENCE_AIRPORT",
  "TRANSFER_TOO_LONG",
  "UNKNOWN_TIMEZONE",
  "NO_PLAUSIBLE_ROUTE",
  "SHORT_ROUTE_UNJUSTIFIED",
  "MISSING_GEOGRAPHIC_EVIDENCE",
  "DOOR_TO_DOOR_TOO_LONG",
]);
export type RouteReason = z.infer<typeof routeReasonSchema>;

export const scheduleReasonSchema = z.enum([
  "OUTBOUND_DATE",
  "ARRIVAL_TOO_LATE",
  "RETURN_DATE",
  "RETURN_TOO_EARLY",
  "CONNECTION_TOO_SHORT",
  "CONNECTION_TOO_LONG",
  "INVALID_DURATION",
  "INVALID_TIMEZONE",
  "INVALID_CONNECTION",
  "PRICE_MISMATCH",
  "TRANSFER_BUFFER",
  "INSUFFICIENT_SIGHTSEEING",
  "STALE_ROUTE_APPROVAL",
  "NO_MATCHING_SCHEDULE",
  "DOOR_TO_DOOR_TOO_LONG",
]);
export type ScheduleReason = z.infer<typeof scheduleReasonSchema>;

export const scenarioDomainSchema = z.enum([
  "flights",
  "hotels",
  "breakfast",
  "lunch",
  "dinner",
  "activities",
  "events",
]);
export type ScenarioDomain = z.infer<typeof scenarioDomainSchema>;

/**
 * Phase 09 research fan-out domains: exactly the non-flight inventories that a
 * parallel research task can cover. `hotel`/`attractions` are the task-facing
 * names of the `hotels`/`activities` scenario domains.
 */
export const researchDomainSchema = z.enum([
  "hotel",
  "breakfast",
  "lunch",
  "dinner",
  "attractions",
  "events",
]);
export type ResearchDomain = z.infer<typeof researchDomainSchema>;

/** Canonical display/dispatch order for research domains. */
export const RESEARCH_DOMAINS: readonly ResearchDomain[] = researchDomainSchema.options;

export const researchDomainStatusSchema = z.enum([
  "ok",
  "unavailable",
  "retryable_error",
  "unsupported",
]);
export type ResearchDomainStatus = z.infer<typeof researchDomainStatusSchema>;

/** Scenario domain behind each research domain (never `flights`). */
export const SCENARIO_DOMAIN_FOR_RESEARCH: Readonly<Record<ResearchDomain, ScenarioDomain>> = {
  hotel: "hotels",
  breakfast: "breakfast",
  lunch: "lunch",
  dinner: "dinner",
  attractions: "activities",
  events: "events",
};

/** The research domain for a scenario domain, or undefined for `flights`. */
export function researchDomainForScenario(domain: ScenarioDomain): ResearchDomain | undefined {
  return (Object.keys(SCENARIO_DOMAIN_FOR_RESEARCH) as ResearchDomain[]).find(
    (research) => SCENARIO_DOMAIN_FOR_RESEARCH[research] === domain,
  );
}

/**
 * Recommendation-artifact service key for each research domain. The artifact
 * convention keeps the display names (`hotel`) and maps the activity domain to
 * its scenario service key (`activities`).
 */
export const ARTIFACT_SERVICE_KEY_FOR_RESEARCH: Readonly<Record<ResearchDomain, string>> = {
  hotel: "hotel",
  breakfast: "breakfast",
  lunch: "lunch",
  dinner: "dinner",
  attractions: "activities",
  events: "events",
};

/** The stable reducer key of one research task: `<researchRunId>:<domain>`. */
export function researchRunKey(researchRunId: string, domain: ResearchDomain): string {
  return `${researchRunId}:${domain}`;
}
