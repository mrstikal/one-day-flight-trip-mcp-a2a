import type { Pool } from "pg";
import type { OperationFencingContext } from "@odft/persistence";
import {
  createTravelBookingService,
  createTravelContextService,
  createTravelItineraryService,
  createTravelResearchService,
  createTravelScenarioService,
  operationAuthority,
  type AiService,
  type LandmarkDiscoveryOptions,
} from "@odft/services";
import type { TravelPorts } from "@odft/workflow";
import { createFencedEventWriter, createFencedRunEffect } from "../driver.js";

/**
 * Build the production `TravelPorts` for one claimed coordinator operation by
 * composing the extracted `@odft/services` layer.
 *
 * The workflow-facing shapes are the canonical service types re-exported by the
 * coordinator ports; the effect runner and fenced event writer come from the
 * driver, and every service is bound to the explicit operation authority of
 * this invocation — a stale or misrouted task can never borrow another
 * operation's fencing token.
 */
export function createTravelPortsFactory(
  pool: Pool,
  ai: AiService,
  options: {
    readonly wikidataDiscovery?: boolean;
    readonly discoveryFetch?: typeof fetch;
    readonly onDiscoveryLog?: LandmarkDiscoveryOptions["logger"];
    /** AI mode label for the itinerary attempt event (worker-owned config). */
    readonly aiMode?: "fixture" | "openrouter";
  } = {},
): (ctx: OperationFencingContext, signal?: AbortSignal) => TravelPorts {
  const insertFencedEvent = createFencedEventWriter(pool);
  const landmarkDiscovery: LandmarkDiscoveryOptions = {
    enabled: options.wikidataDiscovery ?? false,
    ...(options.discoveryFetch ? { fetchImpl: options.discoveryFetch } : {}),
    ...(options.onDiscoveryLog ? { logger: options.onDiscoveryLog } : {}),
  };

  return (ctx: OperationFencingContext, signal?: AbortSignal): TravelPorts => {
    const authority = operationAuthority(ctx);
    const writeEvent = (event: { type: string; payload: unknown }): Promise<void> =>
      insertFencedEvent(ctx, event);

    const contextService = createTravelContextService({
      pool,
      ai,
      authority,
      ...(signal ? { signal } : {}),
    });
    const scenarioService = createTravelScenarioService({
      pool,
      authority,
      landmarkDiscovery,
    });
    const researchService = createTravelResearchService({ pool, authority, writeEvent });
    const bookingService = createTravelBookingService({ pool, authority, writeEvent });
    const itineraryService = createTravelItineraryService({
      pool,
      ai,
      authority,
      writeEvent,
      ...(signal ? { signal } : {}),
    });

    return {
      now: () => new Date(),
      runEffect: createFencedRunEffect(pool, ctx),

      loadTrip: (tripId) => contextService.loadTrip(tripId),
      applyCommands: (input) => contextService.applyCommands(input),
      loadProgress: (tripId) => contextService.loadProgress(tripId),
      loadChatMessage: (operationId) => contextService.loadChatMessage(operationId),
      loadOperationPayload: (operationId) => contextService.loadOperationPayload(operationId),
      interpretIntent: (input) => contextService.interpretIntent(input),

      evaluateRoute: (tripId) => scenarioService.evaluateRoute(tripId),
      materializeFlights: (tripId) => scenarioService.materializeFlights(tripId),
      validateSchedules: (input) => scenarioService.validateSchedules(input),
      ensureDomains: (tripId) => scenarioService.ensureDomains(tripId),
      previewRouteChange: (input) => scenarioService.previewRouteChange(input),
      commitRouteChange: (input) => scenarioService.commitRouteChange(input),

      propose: (input) => bookingService.propose(input),
      confirm: (input) => bookingService.confirm(input),
      replace: (input) => bookingService.replace(input),
      declineBooking: (input) => bookingService.declineBooking(input),
      applyProgram: (input) => bookingService.applyProgram(input),
      validateSelectedLogistics: (input) => bookingService.validateSelectedLogistics(input),

      loadResearchInputs: (tripId, operationId, searchIntent) =>
        researchService.loadResearchInputs(tripId, operationId, searchIntent),
      researchDomain: (input) => researchService.researchDomain(input),
      rankRecommendations: (input) => researchService.rankRecommendations(input),
      recordResearchEvent: (event) => researchService.recordResearchEvent(event),

      prepareItineraryTask: (input) => itineraryService.prepareItineraryTask(input),
      acceptItineraryProposal: (input) =>
        itineraryService.acceptItineraryProposal({
          ...input,
          mode: options.aiMode ?? "fixture",
        }),
      planItinerary: (input) => itineraryService.planItinerary(input),
      reviewItinerary: (input) => itineraryService.reviewItinerary(input),
      approveItinerary: (input) => itineraryService.approveItinerary(input),
    };
  };
}
