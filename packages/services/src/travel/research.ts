import type { Pool } from "pg";
import { loadTripResearchInputs, rankTripRecommendations, researchTripDomain } from "@odft/persistence";
import type { OperationAuthority } from "../ai/authority.js";
import { fencingContextFor } from "../ai/authority.js";
import type {
  RankDomainCandidates,
  RankedServices,
  ResearchDomain,
  ResearchEvent,
  ResearchInputs,
  ResearchOutcome,
  ResearchSearchIntent,
  ServiceEventWriter,
} from "./types.js";

/**
 * Phase 02 research service: the Phase 09 per-domain research/ranking composition
 * over the persistence layer. Domain writes (artifact upsert, fault counters)
 * verify the operation's fencing token inside their own short transactions, so a
 * worker that lost its lease writes nothing.
 */

export interface TravelResearchServiceDeps {
  readonly pool: Pool;
  readonly authority: OperationAuthority;
  readonly writeEvent: ServiceEventWriter;
}

export interface TravelResearchService {
  /** Phase 09: deterministic per-domain research input fingerprints. */
  loadResearchInputs(
    tripId: string,
    operationId: string,
    searchIntent?: ResearchSearchIntent | null,
  ): Promise<ResearchInputs>;
  /** Phase 09: research one domain (provider + idempotent artifact write). */
  researchDomain(input: {
    tripId: string;
    operationId: string;
    domain: ResearchDomain;
    attempt: number;
    inputFingerprint: string;
    /** Phase 11: operation-scoped level override / cheaper comparison. */
    searchIntent?: ResearchSearchIntent | null;
  }): Promise<ResearchOutcome>;
  /** Phase 09: deterministic re-filter/re-order + artifact persistence. */
  rankRecommendations(input: {
    tripId: string;
    operationId: string;
    domains: readonly RankDomainCandidates[];
    /** Phase 11: operation-scoped level override / cheaper comparison. */
    searchIntent?: ResearchSearchIntent | null;
  }): Promise<RankedServices>;
  /** Phase 09: persist one safe domain timing/attempt event. */
  recordResearchEvent(event: ResearchEvent): Promise<void>;
}

export function createTravelResearchService(
  deps: TravelResearchServiceDeps,
): TravelResearchService {
  const { pool, authority, writeEvent } = deps;
  return {
    async loadResearchInputs(tripId, operationId, searchIntent) {
      return loadTripResearchInputs(pool, tripId, operationId, searchIntent ?? null);
    },

    async researchDomain(input) {
      return researchTripDomain(pool, input, fencingContextFor(authority, input.operationId, input.tripId));
    },

    async rankRecommendations(input) {
      return rankTripRecommendations(
        pool,
        input,
        fencingContextFor(authority, input.operationId, input.tripId),
      );
    },

    async recordResearchEvent(event) {
      await writeEvent({
        type: `research.domain_${event.phase}`,
        payload: {
          domain: event.domain,
          attempt: event.attempt,
          durationMs: event.durationMs,
          status: event.status,
          simulatedFailure: event.simulatedFailure,
          reason: event.reason,
          fingerprint: event.fingerprint,
        },
      });
    },
  };
}
