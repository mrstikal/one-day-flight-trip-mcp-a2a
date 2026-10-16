import type { HotelOffer, ServiceLevel } from "@odft/contracts";
import { decideProviderOutcome, type BehaviorOverlay } from "../synthetic/faults.js";
import {
  ok,
  retryableError,
  unavailable,
  unsupported,
  type ProviderResult,
  type SnapshotSource,
} from "./result.js";

/** Accommodation search provider (05 section 11) over a persisted snapshot. */

export interface AccommodationSearchInput {
  readonly snapshotId: string;
  readonly level: ServiceLevel;
  readonly adults: number;
  readonly dates: readonly string[];
  readonly maxNightlyMinor?: number;
  readonly attempt?: number;
}

export interface AccommodationSearchProvider {
  search(input: AccommodationSearchInput): Promise<ProviderResult<HotelOffer[]>>;
}

export class SyntheticAccommodationSearchProvider implements AccommodationSearchProvider {
  constructor(
    private readonly source: SnapshotSource,
    private readonly overlay: BehaviorOverlay | null = null,
  ) {}

  async search(input: AccommodationSearchInput): Promise<ProviderResult<HotelOffer[]>> {
    const decision = this.overlay
      ? decideProviderOutcome(this.overlay, "hotels", input.attempt ?? 1)
      : "ok";
    if (decision === "retryable_error") {
      return retryableError("simulated transient accommodation provider failure");
    }
    if (decision === "unavailable") {
      return unavailable("no compatible hotels are available under the current scenario control");
    }
    const content = await this.source.getContent(input.snapshotId);
    if (!content) {
      return unavailable(`snapshot ${input.snapshotId} is not materialized`);
    }
    if (content.hotels.length === 0) {
      return unsupported("the hotel domain is not materialized in this snapshot version");
    }
    const offers = content.hotels.filter(
      (hotel) =>
        hotel.level === input.level &&
        hotel.adults === input.adults &&
        (input.dates.length === 0 ||
          (hotel.nights === input.dates.length && input.dates[0] === hotel.date)) &&
        (input.maxNightlyMinor === undefined || hotel.perNightMinor <= input.maxNightlyMinor),
    );
    return offers.length > 0
      ? ok(offers)
      : unavailable("no hotel in the snapshot matches the effective category, party, and nights");
  }
}
