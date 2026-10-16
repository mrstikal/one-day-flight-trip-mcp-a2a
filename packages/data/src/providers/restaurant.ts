import type { Meal, RestaurantOffer, ServiceLevel } from "@odft/contracts";
import { decideProviderOutcome, type BehaviorOverlay } from "../synthetic/faults.js";
import {
  ok,
  retryableError,
  unavailable,
  unsupported,
  type ProviderResult,
  type SnapshotSource,
} from "./result.js";

/** Restaurant search provider, filtered by meal and effective level (05 section 11). */

export interface RestaurantSearchInput {
  readonly snapshotId: string;
  readonly meal: Meal;
  readonly level: ServiceLevel;
  readonly adults: number;
  readonly attempt?: number;
}

export interface RestaurantSearchProvider {
  search(input: RestaurantSearchInput): Promise<ProviderResult<RestaurantOffer[]>>;
}

export class SyntheticRestaurantSearchProvider implements RestaurantSearchProvider {
  constructor(
    private readonly source: SnapshotSource,
    private readonly overlay: BehaviorOverlay | null = null,
  ) {}

  async search(input: RestaurantSearchInput): Promise<ProviderResult<RestaurantOffer[]>> {
    const decision = this.overlay
      ? decideProviderOutcome(this.overlay, input.meal, input.attempt ?? 1)
      : "ok";
    if (decision === "retryable_error") {
      return retryableError("simulated transient restaurant provider failure");
    }
    if (decision === "unavailable") {
      return unavailable("no restaurant is available under the current scenario control");
    }
    const content = await this.source.getContent(input.snapshotId);
    if (!content) {
      return unavailable(`snapshot ${input.snapshotId} is not materialized`);
    }
    const mealOffers = content.restaurants.filter((restaurant) => restaurant.meal === input.meal);
    if (mealOffers.length === 0) {
      return unsupported(`the ${input.meal} domain is not materialized in this snapshot version`);
    }
    if (content.context.adults !== input.adults) {
      return unavailable("the snapshot party size does not match the requested party");
    }
    const offers = mealOffers.filter((restaurant) => restaurant.level === input.level);
    return offers.length > 0
      ? ok(offers)
      : unavailable("no restaurant in the snapshot matches the meal and effective level");
  }
}
