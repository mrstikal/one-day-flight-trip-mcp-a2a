import type { CoordinatorStep, CoordinatorWaitReason } from "@odft/contracts";
import type { CoordinatorRunDataInput } from "@odft/persistence";

export type { CoordinatorRunDataInput };

/**
 * Phase 07 coordinator cursor and transition algebra (analysis §3).
 *
 * A claimed coordinator operation runs transitions until it parks (`wait`),
 * completes or fails. Every transition returns the next step plus the run data
 * to persist; the dispatcher commits it together with the operation
 * finalization in one fenced transaction.
 */

/** Accepted (pre-default) run data for a brand-new run. */
export function initialCoordinatorRunData(tripId: string): CoordinatorRunDataInput {
  void tripId;
  return { schemaVersion: 1, affectedDomains: [], expectedFingerprints: {} };
}

export type CoordinatorTransitionResult =
  | {
      readonly kind: "continue";
      readonly step: CoordinatorStep;
      readonly runData: CoordinatorRunDataInput;
    }
  | {
      readonly kind: "wait";
      readonly step: "awaiting_user";
      readonly waitReason: CoordinatorWaitReason;
      readonly runData: CoordinatorRunDataInput;
      readonly fingerprint: string;
      readonly allowedOptionIds: readonly string[];
      readonly allowedOfferIds?: readonly string[];
      readonly proposalId?: string;
      readonly optionPayload?: unknown;
    }
  | {
      readonly kind: "complete";
      readonly runData: CoordinatorRunDataInput;
      readonly result: unknown;
      readonly summary: string;
      readonly workflowStatus?: "ready" | "blocked";
    }
  | {
      readonly kind: "fail";
      readonly runData: CoordinatorRunDataInput;
      readonly code: string;
      readonly reason: string;
    }
  | {
      /**
       * Phase 07 delegation waits: the operation stays `running` (no
       * finalization); its lease expires and the next claim resumes the same
       * step, re-reading saved tasks. The cursor was already persisted by an
       * earlier `continue`/`extraWrites` write.
       */
      readonly kind: "abandon";
      readonly runData: CoordinatorRunDataInput;
    };

/** Short progress label persisted with the operation event of one step. */
export function stepProgressLabel(step: CoordinatorStep): string {
  switch (step) {
    case "initializing":
      return "coordinator run initializing";
    case "interpreting":
      return "coordinator interpreting the request";
    case "validating_route":
      return "coordinator validating the route";
    case "requesting_flights":
      return "coordinator requesting flights from the specialist";
    case "researching":
      return "coordinator researching with the specialists";
    case "validating_logistics":
      return "coordinator validating the selected logistics";
    case "planning":
      return "coordinator planning the program";
    case "awaiting_user":
      return "coordinator awaiting the traveler's decision";
    case "completed":
      return "coordinator run completed";
    case "failed":
      return "coordinator run failed";
    case "cancelled":
      return "coordinator run cancelled";
  }
}
