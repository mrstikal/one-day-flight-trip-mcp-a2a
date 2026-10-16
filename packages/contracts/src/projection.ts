import { z } from "zod";
import {
  activityCategorySchema,
  activityTagSchema,
  bookableKeySchema,
  mealSchema,
  proposalStatusSchema,
  reservationStatusSchema,
  researchDomainSchema,
  scheduleReasonSchema,
  serviceLevelSchema,
  travelVariantSchema,
} from "./enums.js";
import { routeAlternativeSchema, routeReasonEntrySchema } from "./feasibility.js";
import {
  coordinatesSchema,
  instantSchema,
  localDateSchema,
  moneyMinorSchema,
  nonEmptyStringSchema,
  timeZoneSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Public, safe flight/booking projection DTOs (08-frontend-ux.md sections 3-5,
 * 09-booking-simulation.md section 10). The client renders only these
 * server-computed values; it never derives prices, feasibility, or booking
 * decisions. No internal hashes, fingerprints, or provider payloads appear here.
 */

export const publicFlightSegmentSchema = z
  .object({
    fromAirportId: nonEmptyStringSchema,
    toAirportId: nonEmptyStringSchema,
    fromIata: nonEmptyStringSchema,
    toIata: nonEmptyStringSchema,
    departureInstant: instantSchema,
    arrivalInstant: instantSchema,
    departureZone: timeZoneSchema,
    arrivalZone: timeZoneSchema,
    elapsedMinutes: z.number().int().min(1),
    /** Minutes between this segment's arrival and the next segment's departure. */
    layoverAfterMinutes: z.number().int().min(0),
    airlineName: nonEmptyStringSchema,
    airlineCode: nonEmptyStringSchema,
    flightNumber: nonEmptyStringSchema,
  })
  .strict();
export type PublicFlightSegment = z.infer<typeof publicFlightSegmentSchema>;

export const publicFlightDirectionSchema = z
  .object({
    direction: z.enum(["outbound", "inbound"]),
    segments: z.array(publicFlightSegmentSchema).min(1).max(2),
  })
  .strict();
export type PublicFlightDirection = z.infer<typeof publicFlightDirectionSchema>;

export const publicFlightCombinationSchema = z
  .object({
    id: nonEmptyStringSchema,
    outbound: publicFlightDirectionSchema,
    inbound: publicFlightDirectionSchema,
    adults: z.number().int().min(1).max(6),
    supportedVariants: z.array(travelVariantSchema).min(1),
    perAdultMinor: moneyMinorSchema,
    partyTotalMinor: moneyMinorSchema,
    /** Total stops per direction, computed server-side (never by the client). */
    outboundStops: z.number().int().min(0).max(2),
    inboundStops: z.number().int().min(0).max(2),
    /** Door-to-door travel minutes per direction (includes layovers). */
    outboundTravelMinutes: z.number().int().positive(),
    inboundTravelMinutes: z.number().int().positive(),
    /** Outbound + inbound total travel time in minutes, computed server-side. */
    totalTravelMinutes: z.number().int().positive(),
    demoLabels: z.array(nonEmptyStringSchema),
  })
  .strict();
export type PublicFlightCombination = z.infer<typeof publicFlightCombinationSchema>;

export const flightGatingSchema = z
  .object({
    routeStatus: z.enum(["PENDING", "FEASIBLE", "INFEASIBLE", "UNDETERMINED"]),
    routeReasons: z.array(routeReasonEntrySchema),
    alternatives: z.array(routeAlternativeSchema),
    scheduleStatus: z.enum(["PENDING", "VALID", "NO_VALID_OFFERS"]),
    /** Distinct schedule-rejection codes from the current Stage B result. */
    scheduleReasons: z.array(scheduleReasonSchema).default(() => []),
    scheduleExplanation: nonEmptyStringSchema.nullable().default(null),
    offers: z.array(publicFlightCombinationSchema),
    /** Whether a valid one-night schedule exists for the current route. */
    oneNightAvailable: z.boolean(),
  })
  .strict();
export type FlightGating = z.infer<typeof flightGatingSchema>;

export const publicProposalSchema = z
  .object({
    id: uuidSchema,
    serviceKey: bookableKeySchema,
    offerId: nonEmptyStringSchema,
    partyTotalMinor: moneyMinorSchema,
    priceDeltaMinor: z.number().int().nullable(),
    status: proposalStatusSchema,
    expiresAt: instantSchema,
    /** Server-computed: the proposal TTL has passed (client must not compare clocks). */
    expired: z.boolean(),
  })
  .strict();
export type PublicProposal = z.infer<typeof publicProposalSchema>;

export const publicReservationSchema = z
  .object({
    id: uuidSchema,
    serviceKey: bookableKeySchema,
    offerId: nonEmptyStringSchema,
    status: reservationStatusSchema,
    demoReference: nonEmptyStringSchema,
    partyTotalMinor: moneyMinorSchema,
    createdAt: instantSchema,
  })
  .strict();
export type PublicReservation = z.infer<typeof publicReservationSchema>;

/** Safe display flags exposed through the projection (never secrets). */
export const tripDisplaySchema = z
  .object({
    aiMode: z.enum(["fixture", "openrouter"]),
    demoControlsEnabled: z.boolean(),
    /**
     * Public, credential-free tile URL template (`{z}/{x}/{y}`); null = the map
     * runs with the labeled SVG fallback (Phase 10 map policy). Userinfo is
     * rejected so a credentialed URL can never reach the browser payload.
     */
    mapTileUrl: z
      .string()
      .regex(/^https?:\/\/(?![^/]*@)/)
      .nullable(),
  })
  .strict();
export type TripDisplay = z.infer<typeof tripDisplaySchema>;

/* ---- Phase 07 hotel/meal/program projections -------------------------------- */

export const publicHotelOfferSchema = z
  .object({
    id: nonEmptyStringSchema,
    level: serviceLevelSchema,
    name: nonEmptyStringSchema,
    date: localDateSchema,
    nights: z.number().int().min(1).max(7),
    adults: z.number().int().min(1).max(6),
    rooms: z.number().int().min(1).max(6),
    perNightMinor: moneyMinorSchema,
    partyTotalMinor: moneyMinorSchema,
    rating: z.number().min(0).max(5),
    anchor: coordinatesSchema,
    centerDistanceKm: z.number().nonnegative(),
    luggageStorage: z.boolean(),
    checkInWindow: nonEmptyStringSchema,
    checkOutWindow: nonEmptyStringSchema,
    synthetic: z.literal(true),
    demoLabels: z.array(nonEmptyStringSchema),
  })
  .strict();
export type PublicHotelOffer = z.infer<typeof publicHotelOfferSchema>;

export const publicMealOfferSchema = z
  .object({
    id: nonEmptyStringSchema,
    meal: mealSchema,
    level: serviceLevelSchema,
    name: nonEmptyStringSchema,
    cuisine: nonEmptyStringSchema,
    perAdultMinor: moneyMinorSchema,
    partyTotalMinor: moneyMinorSchema,
    durationMinutes: z.number().int().min(15).max(240),
    windowStart: nonEmptyStringSchema,
    windowEnd: nonEmptyStringSchema,
    anchor: coordinatesSchema,
    centerDistanceKm: z.number().nonnegative(),
    synthetic: z.literal(true),
    demoLabels: z.array(nonEmptyStringSchema),
  })
  .strict();
export type PublicMealOffer = z.infer<typeof publicMealOfferSchema>;

export const publicActivityChoiceSchema = z
  .object({
    id: nonEmptyStringSchema,
    kind: z.enum(["landmark", "generic"]),
    name: nonEmptyStringSchema,
    cityId: nonEmptyStringSchema,
    category: activityCategorySchema,
    tags: z.array(activityTagSchema),
    durationMinutes: z.number().int().min(10).max(240),
    ticketMinorPerAdult: moneyMinorSchema,
    reference: z.boolean(),
    demoLabels: z.array(nonEmptyStringSchema),
  })
  .strict();
export type PublicActivityChoice = z.infer<typeof publicActivityChoiceSchema>;

/** Effective service level plus whether it comes from an explicit override. */
export const publicServiceLevelStateSchema = z
  .object({
    level: serviceLevelSchema,
    inherited: z.boolean(),
  })
  .strict();
export type PublicServiceLevelState = z.infer<typeof publicServiceLevelStateSchema>;

export const publicProgramChoicesSchema = z
  .object({
    mealDefaults: z
      .object({
        breakfast: nonEmptyStringSchema.nullable(),
        lunch: nonEmptyStringSchema.nullable(),
        dinner: nonEmptyStringSchema.nullable(),
      })
      .strict(),
    /** Persisted program meal choices (null when not selected yet). */
    selectedMeals: z
      .object({
        breakfast: nonEmptyStringSchema.nullable(),
        lunch: nonEmptyStringSchema.nullable(),
        dinner: nonEmptyStringSchema.nullable(),
      })
      .strict(),
    /** Explicit "I'll arrange it myself" state per meal (never planned). */
    selfArrangedMeals: z
      .object({
        breakfast: z.boolean(),
        lunch: z.boolean(),
        dinner: z.boolean(),
      })
      .strict(),
    /** Deterministic reason dinner is optional (null), or null when a slot exists. */
    dinnerNotIncludedReason: nonEmptyStringSchema.nullable(),
    /** Persisted program activity preferences (safe ids). */
    preferredActivityIds: z.array(nonEmptyStringSchema),
    /** Explicit "I'll arrange the activities myself" state (never planned). */
    activitiesSelfArranged: z.boolean(),
    activities: z.array(publicActivityChoiceSchema),
  })
  .strict();
export type PublicProgramChoices = z.infer<typeof publicProgramChoicesSchema>;

export const publicServiceLevelsSchema = z
  .object({
    hotel: publicServiceLevelStateSchema,
    breakfast: publicServiceLevelStateSchema,
    lunch: publicServiceLevelStateSchema,
    dinner: publicServiceLevelStateSchema,
  })
  .strict();
export type PublicServiceLevels = z.infer<typeof publicServiceLevelsSchema>;

/* ---- Phase 11 route-change impact preview ----------------------------------- */

export const routeChangeFieldSchema = z.enum([
  "originAirportId",
  "destinationCityId",
  "sightseeingDate",
  "travelVariant",
]);
export type RouteChangeField = z.infer<typeof routeChangeFieldSchema>;

export const publicRouteSummarySchema = z
  .object({
    originAirportId: nonEmptyStringSchema,
    destinationCityId: nonEmptyStringSchema,
    destinationCountryKey: z.string().regex(/^[A-Z]{2}$/),
    sightseeingDate: localDateSchema,
    travelVariant: travelVariantSchema,
  })
  .strict();
export type PublicRouteSummary = z.infer<typeof publicRouteSummarySchema>;

/** One confirmed reservation the pending route change would cancel. */
export const publicRouteChangeReservationSchema = z
  .object({
    id: uuidSchema,
    serviceKey: bookableKeySchema,
    offerId: nonEmptyStringSchema,
    demoReference: nonEmptyStringSchema,
    partyTotalMinor: moneyMinorSchema,
  })
  .strict();
export type PublicRouteChangeReservation = z.infer<typeof publicRouteChangeReservationSchema>;

/**
 * Server-built impact preview for an admitted `set_route` that would invalidate
 * confirmed reservations. It is shown before confirmation; the reservations stay
 * active until `confirm_route_change` commits the cancellation atomically.
 */
export const publicRouteChangePreviewSchema = z
  .object({
    proposalId: uuidSchema,
    changedFields: z.array(routeChangeFieldSchema).min(1),
    from: publicRouteSummarySchema,
    to: publicRouteSummarySchema,
    affectedReservations: z.array(publicRouteChangeReservationSchema),
  })
  .strict();
export type PublicRouteChangePreview = z.infer<typeof publicRouteChangePreviewSchema>;

/* ---- Phase 09 research fan-out state ---------------------------------------- */

/**
 * Public domain outcome: the persisted statuses plus `pending` for a domain whose
 * research has started in the latest run but has not finished yet (the UI must
 * not fall back to the raw inventory while a domain is still being researched).
 */
export const publicResearchStatusSchema = z.enum([
  "pending",
  "ok",
  "unavailable",
  "retryable_error",
  "unsupported",
]);
export type PublicResearchStatus = z.infer<typeof publicResearchStatusSchema>;

export const publicResearchDomainStateSchema = z
  .object({
    domain: researchDomainSchema,
    status: publicResearchStatusSchema,
    /** Provider attempts used for this domain in the latest research run. */
    attempts: z.number().int().min(1).max(2),
    /** True when an injected simulation fault was observed for this domain. */
    simulatedFailure: z.boolean(),
    /** Safe short explanation (never a provider payload or hash). */
    reason: nonEmptyStringSchema.max(400).nullable(),
  })
  .strict();
export type PublicResearchDomainState = z.infer<typeof publicResearchDomainStateSchema>;

export const publicResearchStateSchema = z
  .object({
    /** Latest persisted outcome per domain of the most recent research run. */
    domains: z.array(publicResearchDomainStateSchema),
    /** Domains whose latest outcome is a failure; a retry may be offered. */
    failedDomains: z.array(researchDomainSchema),
    /** Any simulated failure observed in the latest research run. */
    simulatedFailure: z.boolean(),
  })
  .strict();
export type PublicResearchState = z.infer<typeof publicResearchStateSchema>;
