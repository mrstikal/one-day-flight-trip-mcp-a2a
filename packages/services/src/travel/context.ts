import type { Pool } from "pg";
import { chatCommandPayloadSchema, type DomainCommand } from "@odft/contracts";
import {
  applyTripCommands,
  getOperationPayload,
  getTrip,
  loadTripProgress,
} from "@odft/persistence";
import type { OperationAuthority } from "../ai/authority.js";
import type { AiService } from "../ai/runtime.js";
import type { IntentInterpretation, TripContext, TripProgress } from "./types.js";

/**
 * Phase 02 trip-context service: trip records, admitted command batches, the
 * assistant chat payloads and intent interpretation. Composition only — every
 * read/write goes through the persistence layer and the governed AI runtime.
 */

export interface TravelContextServiceDeps {
  readonly pool: Pool;
  readonly ai: AiService;
  readonly authority: OperationAuthority;
  /** Driver abort signal (shutdown/lease loss), forwarded to AI calls. */
  readonly signal?: AbortSignal;
}

export interface TravelContextService {
  loadTrip(tripId: string): Promise<TripContext | undefined>;
  applyCommands(input: {
    tripId: string;
    operationId: string;
    commands: readonly DomainCommand[];
  }): Promise<{ routeChanged: boolean; appliedCount: number }>;
  loadProgress(tripId: string): Promise<TripProgress>;
  /** Phase 08: read the admitted chat message of an internal `modify` operation. */
  loadChatMessage(operationId: string): Promise<string | undefined>;
  /** Phase 11: the admitted operation payload, so a typed modification applies
   * through the deterministic dispatcher without an LLM call. */
  loadOperationPayload(operationId: string): Promise<unknown>;
  /** Phase 08: interpret one chat message through the configured AI role. */
  interpretIntent(input: {
    tripId: string;
    operationId: string;
    message: string;
  }): Promise<IntentInterpretation>;
}

export function createTravelContextService(deps: TravelContextServiceDeps): TravelContextService {
  const { pool, ai, authority, signal } = deps;
  return {
    async loadTrip(tripId) {
      const trip = await getTrip(pool, tripId);
      return trip ? { trip } : undefined;
    },

    async applyCommands(input) {
      return applyTripCommands(pool, { tripId: input.tripId, commands: input.commands });
    },

    async loadProgress(tripId) {
      return loadTripProgress(pool, tripId);
    },

    async loadChatMessage(operationId) {
      const payload = await getOperationPayload(pool, operationId);
      const parsed = chatCommandPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data.message : undefined;
    },

    async loadOperationPayload(operationId) {
      return getOperationPayload(pool, operationId);
    },

    async interpretIntent(input) {
      return ai.interpret({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: authority.fencingToken,
        message: input.message,
        ...(signal ? { signal } : {}),
      });
    },
  };
}
