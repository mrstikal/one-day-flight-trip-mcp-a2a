import { z } from "zod";
import { routeReasonSchema, scheduleReasonSchema, travelVariantSchema } from "./enums.js";
import {
  airportCodeSchema,
  countryKeySchema,
  fingerprintSchema,
  instantSchema,
  localDateSchema,
  moneyMinorSchema,
  timeZoneSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Two-stage flight feasibility contracts (04-domain-model.md sections 4-5,
 * 05-synthetic-data-design.md sections 5-6). Stage A (`validateRoute`) is the
 * pure route-policy decision; Stage B (`validateSchedules`) independently
 * validates generated combinations. Neither calls an LLM.
 */

export const ROUTE_POLICY_VERSION = "route-policy-v1" as const;
export const SCHEDULE_RULE_VERSION = "schedule-rule-v1" as const;

export const routeAlternativeSchema = z.enum([
  "change_origin",
  "change_destination",
  "choose_ground_travel_elsewhere",
]);
export type RouteAlternative = z.infer<typeof routeAlternativeSchema>;

export const routeReasonEntrySchema = z
  .object({ code: routeReasonSchema, explanation: z.string().min(1) })
  .strict();
export type RouteReasonEntry = z.infer<typeof routeReasonEntrySchema>;

/**
 * One airport as bound by the route fingerprint. The origin entry uses
 * `eligibleOrigin`; destination candidates use `eligibleDestination`.
 */
export const routeAirportSchema = z
  .object({
    airportId: z.string().min(1),
    iata: airportCodeSchema,
    countryKey: countryKeySchema,
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    zone: timeZoneSchema.nullable(),
    zoneResolved: z.boolean(),
    metroCatchmentId: z.string().min(1).nullable(),
    transferMinutes: z.number().int().min(0).max(600).nullable(),
    transferMode: z.enum(["public_transport", "taxi"]).nullable(),
    eligibleOrigin: z.boolean(),
    eligibleDestination: z.boolean(),
    largeAirport: z.boolean(),
    reviewed: z.boolean(),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict();
export type RouteAirport = z.infer<typeof routeAirportSchema>;

export const routeDestinationSchema = z
  .object({
    countryKey: countryKeySchema,
    cityId: z.string().min(1),
    name: z.string().min(1),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    zone: timeZoneSchema.nullable(),
    zoneResolved: z.boolean(),
    metroCatchmentId: z.string().min(1).nullable(),
    isCurated: z.boolean(),
  })
  .strict();
export type RouteDestination = z.infer<typeof routeDestinationSchema>;

export const routeGroundCorridorSchema = z
  .object({
    originRef: z.string().min(1),
    destinationRef: z.string().min(1),
    minutes: z.number().int().min(0).max(600),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict();
export type RouteGroundCorridor = z.infer<typeof routeGroundCorridorSchema>;

export const routeIslandExceptionSchema = z
  .object({
    originRef: z.string().min(1),
    destinationRef: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict();
export type RouteIslandException = z.infer<typeof routeIslandExceptionSchema>;

export const routeHubSchema = z
  .object({
    iata: airportCodeSchema,
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    zone: timeZoneSchema,
  })
  .strict();
export type RouteHub = z.infer<typeof routeHubSchema>;

/** Deterministic door-to-door transfer assumptions, bound by the fingerprint. */
export const routeTransferPolicySchema = z
  .object({
    originAccessMinutes: z.number().int().min(0).max(600),
    departureBufferMinutes: z.number().int().min(0).max(600),
    arrivalClearanceMinutes: z.number().int().min(0).max(600),
    maxDestinationTransferMinutes: z.number().int().min(0).max(600),
    minConnectionMinutes: z.number().int().min(0).max(600),
    maxConnectionMinutes: z.number().int().min(0).max(600),
  })
  .strict();
export type RouteTransferPolicy = z.infer<typeof routeTransferPolicySchema>;

export const routeInputsSchema = z
  .object({
    schemaVersion: z.string().min(1),
    routePolicyVersion: z.string().min(1),
    generatorVersion: z.string().min(1),
    referenceVersion: z.string().min(1),
    origin: routeAirportSchema,
    destination: routeDestinationSchema,
    originKnown: z.boolean(),
    destinationKnown: z.boolean(),
    destinationAirports: z.array(routeAirportSchema),
    groundCorridors: z.array(routeGroundCorridorSchema),
    islandExceptions: z.array(routeIslandExceptionSchema),
    curatedDirectPairs: z.array(z.tuple([airportCodeSchema, airportCodeSchema])),
    hubAirports: z.array(routeHubSchema),
    sightseeingDate: localDateSchema,
    travelVariant: travelVariantSchema,
    adults: z.number().int().min(1).max(6),
    transfer: routeTransferPolicySchema,
  })
  .strict();
export type RouteInputs = z.infer<typeof routeInputsSchema>;

export const approvedRoutePairSchema = z
  .object({
    originAirportId: z.string().min(1),
    originIata: airportCodeSchema,
    originZone: timeZoneSchema,
    originLat: z.number().min(-90).max(90),
    originLon: z.number().min(-180).max(180),
    destinationAirportId: z.string().min(1),
    destinationIata: airportCodeSchema,
    destinationZone: timeZoneSchema,
    destinationLat: z.number().min(-90).max(90),
    destinationLon: z.number().min(-180).max(180),
    destinationTransferMinutes: z.number().int().min(0).max(600),
    distanceKm: z.number().nonnegative(),
    connectionHub: routeHubSchema.nullable(),
    isException: z.boolean(),
    airDoorToDoorMinutes: z.number().int().positive(),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict();
export type ApprovedRoutePair = z.infer<typeof approvedRoutePairSchema>;

export const feasibleRouteValidationSchema = z
  .object({
    status: z.literal("FEASIBLE"),
    id: uuidSchema.optional(),
    fingerprint: fingerprintSchema,
    policyVersion: z.string().min(1),
    approvedAirportPairs: z.array(z.tuple([airportCodeSchema, airportCodeSchema])),
    approvedPairDetails: z.array(approvedRoutePairSchema),
    evidenceRefs: z.array(z.string().min(1)),
    warnings: z.array(routeReasonEntrySchema),
    expiresWithInputs: z.literal(true),
  })
  .strict();

export const nonFeasibleRouteValidationSchema = z
  .object({
    status: z.enum(["INFEASIBLE", "UNDETERMINED"]),
    id: uuidSchema.optional(),
    fingerprint: fingerprintSchema,
    policyVersion: z.string().min(1),
    reasons: z.array(routeReasonEntrySchema).min(1),
    alternatives: z.array(routeAlternativeSchema),
  })
  .strict();

export const routeValidationSchema = z.discriminatedUnion("status", [
  feasibleRouteValidationSchema,
  nonFeasibleRouteValidationSchema,
]);
export type RouteValidation = z.infer<typeof routeValidationSchema>;
export type FeasibleRouteValidation = z.infer<typeof feasibleRouteValidationSchema>;

/**
 * Server-created validated reference to a persisted `FEASIBLE` result. The
 * generator and booking service re-read it and compare `fingerprint` with a
 * fresh computation from current inputs; it is never a graph boolean.
 */
export const feasibleRouteApprovalSchema = z
  .object({
    routeValidationId: uuidSchema,
    status: z.literal("FEASIBLE"),
    fingerprint: fingerprintSchema,
    policyVersion: z.string().min(1),
    approvedAirportPairs: z.array(z.tuple([airportCodeSchema, airportCodeSchema])),
    approvedPairDetails: z.array(approvedRoutePairSchema),
    expiresWithInputs: z.literal(true),
  })
  .strict();
export type FeasibleRouteApproval = z.infer<typeof feasibleRouteApprovalSchema>;

// --- Stage B: generation and schedule validation ---

export const flightSegmentSchema = z
  .object({
    fromAirportId: z.string().min(1),
    toAirportId: z.string().min(1),
    fromIata: airportCodeSchema,
    toIata: airportCodeSchema,
    departureInstant: instantSchema,
    arrivalInstant: instantSchema,
    departureZone: timeZoneSchema,
    arrivalZone: timeZoneSchema,
    elapsedMinutes: z.number().int().min(1),
    airlineName: z.string().min(1),
    airlineCode: z.string().min(1),
    flightNumber: z.string().min(1),
  })
  .strict();
export type FlightSegment = z.infer<typeof flightSegmentSchema>;

export const flightDirectionSchema = z
  .object({
    direction: z.enum(["outbound", "inbound"]),
    segments: z.array(flightSegmentSchema).min(1).max(2),
  })
  .strict();
export type FlightDirection = z.infer<typeof flightDirectionSchema>;

export const flightCombinationSchema = z
  .object({
    id: z.string().min(1),
    scenarioSnapshotId: uuidSchema.optional(),
    outbound: flightDirectionSchema,
    inbound: flightDirectionSchema,
    adults: z.number().int().min(1).max(6),
    supportedVariants: z.array(travelVariantSchema).min(1),
    perAdultMinor: moneyMinorSchema,
    partyTotalMinor: moneyMinorSchema,
    synthetic: z.literal(true),
    demoLabels: z.array(z.string().min(1)),
  })
  .strict();
export type FlightCombination = z.infer<typeof flightCombinationSchema>;

export const scheduleRejectionSchema = z
  .object({
    combinationId: z.string().min(1),
    codes: z.array(scheduleReasonSchema).min(1),
  })
  .strict();
export type ScheduleRejection = z.infer<typeof scheduleRejectionSchema>;

export const scheduleValidationSchema = z
  .object({
    id: uuidSchema.optional(),
    status: z.enum(["VALID", "NO_VALID_OFFERS"]),
    routeValidationId: uuidSchema,
    fingerprint: fingerprintSchema,
    validCombinationIds: z.array(z.string().min(1)),
    rejected: z.array(scheduleRejectionSchema),
    explanation: z.string().min(1),
  })
  .strict();
export type ScheduleValidation = z.infer<typeof scheduleValidationSchema>;

export const scheduleValidationInputSchema = z
  .object({
    approval: feasibleRouteApprovalSchema,
    combinations: z.array(flightCombinationSchema),
    scenarioKey: z.string().min(1),
    flightDomainVersion: z.number().int().min(0),
    flightDomainHash: fingerprintSchema,
    scheduleRuleVersion: z.string().min(1),
    sightseeingDate: localDateSchema,
    travelVariant: travelVariantSchema,
    destinationZone: timeZoneSchema,
    destinationTransferMinutes: z.number().int().min(0).max(600),
    routeValidationId: uuidSchema,
  })
  .strict();
export type ScheduleValidationInput = z.infer<typeof scheduleValidationInputSchema>;
