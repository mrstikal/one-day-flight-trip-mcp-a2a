import type { FeasibleRouteApproval, FlightCombination, TravelVariant } from "@odft/contracts";
import { decideProviderOutcome, type BehaviorOverlay } from "../synthetic/faults.js";
import {
  ok,
  retryableError,
  unavailable,
  unsupported,
  type ProviderResult,
  type SnapshotSource,
} from "./result.js";

/**
 * Flight search provider (05 section 11). Returns candidate combinations from a
 * stable persisted snapshot; it never generates a schedule on demand.
 */

export interface FlightSearchInput {
  readonly snapshotId: string;
  readonly approval: FeasibleRouteApproval;
  readonly travelVariant: TravelVariant;
  readonly adults: number;
  readonly attempt?: number;
}

export interface FlightSearchProvider {
  search(input: FlightSearchInput): Promise<ProviderResult<FlightCombination[]>>;
}

export class SyntheticFlightSearchProvider implements FlightSearchProvider {
  constructor(
    private readonly source: SnapshotSource,
    private readonly overlay: BehaviorOverlay | null = null,
  ) {}

  async search(input: FlightSearchInput): Promise<ProviderResult<FlightCombination[]>> {
    const decision = this.overlay
      ? decideProviderOutcome(this.overlay, "flights", input.attempt ?? 1)
      : "ok";
    if (decision === "retryable_error") {
      return retryableError("simulated transient flight provider failure");
    }
    if (decision === "unavailable") {
      return unavailable("no flights are available under the current scenario control");
    }
    const content = await this.source.getContent(input.snapshotId);
    if (!content) {
      return unavailable(`snapshot ${input.snapshotId} is not materialized`);
    }
    if (content.flights.length === 0) {
      return unsupported("the flights domain is not materialized in this snapshot version");
    }
    if (content.routeFingerprint !== input.approval.fingerprint) {
      return unavailable(
        "the snapshot was generated for a different route approval and must be regenerated",
      );
    }
    const approvedPairs = new Set(
      input.approval.approvedAirportPairs.map(([from, to]) => `${from}-${to}`),
    );
    const combinations = content.flights.filter((combination) => {
      const outbound = combination.outbound.segments[0];
      const outboundLast = combination.outbound.segments[combination.outbound.segments.length - 1];
      if (!outbound || !outboundLast) {
        return false;
      }
      const pair = `${outbound.fromIata}-${outboundLast.toIata}`;
      return (
        approvedPairs.has(pair) &&
        combination.supportedVariants.includes(input.travelVariant) &&
        combination.adults === input.adults
      );
    });
    return combinations.length > 0
      ? ok(combinations)
      : unavailable(
          "no combination in the snapshot matches the approved route, variant, and party",
        );
  }
}
