import type { Pool } from "pg";
import {
  commitRouteChange,
  evaluateAndPersistRoute,
  getTrip,
  materializeFlightSnapshot,
  previewRouteChange,
  ScenarioService,
  validateAndPersistSchedules,
} from "@odft/persistence";
import type { DomainCommand } from "@odft/contracts";
import type { OperationAuthority } from "../ai/authority.js";
import { ensureCityLandmarks, type LandmarkDiscoveryOptions } from "./landmark-discovery.js";
import type {
  MaterializedFlights,
  RouteChangePreview,
  RouteValidation,
  ScheduleValidation,
} from "./types.js";

/**
 * Phase 02 scenario service: route feasibility, flight materialization, schedule
 * validation, domain materialization and route changes. The two feasibility
 * stages and every persistence effect stay in the persistence layer; this
 * module composes them exactly as the worker did (no behavior change).
 */

/** Phase 07/09: the domains materialized before research. */
const RESEARCH_MATERIALIZED_DOMAINS = [
  "hotels",
  "breakfast",
  "lunch",
  "dinner",
  "activities",
  "events",
] as const;

export interface TravelScenarioServiceDeps {
  readonly pool: Pool;
  readonly authority: OperationAuthority;
  /**
   * On-demand landmark curation settings (optional; disabled by default, and
   * never enabled in tests).
   */
  readonly landmarkDiscovery?: LandmarkDiscoveryOptions;
}

export interface TravelScenarioService {
  evaluateRoute(tripId: string): Promise<RouteValidation>;
  materializeFlights(tripId: string): Promise<MaterializedFlights | undefined>;
  validateSchedules(input: { tripId: string; snapshotId: string }): Promise<ScheduleValidation>;
  /** Phase 07/09: idempotently materialize hotels/meals/activities/events. */
  ensureDomains(tripId: string): Promise<{ materializedDomains: string[]; snapshotId: string }>;
  /**
   * Phase 11: compute the impact of a `set_route` batch without applying it.
   */
  previewRouteChange(input: {
    tripId: string;
    operationId: string;
    commands: readonly DomainCommand[];
  }): Promise<RouteChangePreview>;
  /**
   * Phase 11: apply a confirmed route change atomically (deferred commands +
   * reservation cancellations in one transaction).
   */
  commitRouteChange(input: {
    tripId: string;
    operationId: string;
    decisionId: string;
    acceptedRevision: number;
    proposalId: string;
    affectedReservationIds: readonly string[];
    commands: readonly DomainCommand[];
  }): Promise<{ cancelledReservationIds: string[] }>;
}

export function createTravelScenarioService(
  deps: TravelScenarioServiceDeps,
): TravelScenarioService {
  const { pool, authority } = deps;
  const scenarios = new ScenarioService(pool);
  const discoveryOptions: LandmarkDiscoveryOptions = {
    enabled: deps.landmarkDiscovery?.enabled ?? false,
    ...(deps.landmarkDiscovery?.fetchImpl ? { fetchImpl: deps.landmarkDiscovery.fetchImpl } : {}),
    ...(deps.landmarkDiscovery?.language ? { language: deps.landmarkDiscovery.language } : {}),
    ...(deps.landmarkDiscovery?.logger ? { logger: deps.landmarkDiscovery.logger } : {}),
  };

  return {
    async evaluateRoute(tripId) {
      // On-demand curation runs before the route inputs fix the snapshot's
      // `isCurated`, so a discovered city immediately gets real landmark
      // activities; failures are non-fatal (generic categories remain).
      const trip = await getTrip(pool, tripId);
      if (trip) {
        await ensureCityLandmarks(pool, trip.destinationCityId, discoveryOptions);
      }
      const evaluated = await evaluateAndPersistRoute(pool, tripId);
      if (!evaluated) {
        throw new Error(`cannot evaluate route for trip ${tripId}: missing reference inputs`);
      }
      return evaluated.result;
    },

    async materializeFlights(tripId) {
      const materialized = await materializeFlightSnapshot(pool, tripId);
      return materialized
        ? { scenarioKey: materialized.scenarioKey, snapshotId: materialized.snapshotId }
        : undefined;
    },

    async validateSchedules(input) {
      const result = await validateAndPersistSchedules(pool, input.tripId, input.snapshotId);
      if (!result) {
        throw new Error(
          `cannot validate schedules for trip ${input.tripId}: snapshot or approval missing`,
        );
      }
      return result;
    },

    async ensureDomains(tripId) {
      const manifest = await scenarios.ensureDomains(tripId, [...RESEARCH_MATERIALIZED_DOMAINS]);
      return { materializedDomains: manifest.materializedDomains, snapshotId: manifest.snapshotId };
    },

    async previewRouteChange(input) {
      return previewRouteChange(pool, { tripId: input.tripId, commands: input.commands });
    },

    async commitRouteChange(input) {
      return commitRouteChange(pool, {
        tripId: input.tripId,
        operationId: input.operationId,
        decisionId: input.decisionId,
        proposalId: input.proposalId,
        affectedReservationIds: input.affectedReservationIds,
        commands: input.commands,
        fencingToken: authority.fencingToken,
      });
    },
  };
}
