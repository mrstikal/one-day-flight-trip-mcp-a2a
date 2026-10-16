import type { ResearchSearchIntent } from "@odft/contracts";

/**
 * Phase 11 objective handling for an alternative search
 * (`find_alternatives`).
 *
 * The deterministic ranking of a searched domain must honor the requested
 * objective instead of always ordering by price:
 *
 * - `cheaper` excludes the bound offer and prefers strictly cheaper offers (the
 *   same-category list minus the bound offer is the honest fallback when none is
 *   cheaper — never the current offer, never a fabricated claim);
 * - `better_location` orders by distance to the centre (hotels and meals);
 * - `higher_rating` orders hotels by rating (meals keep the price order, they
 *   carry no rating);
 * - every non-`match_preferences` objective excludes the bound offer, because an
 *   "alternative" search must propose an alternative;
 * - `match_preferences` (a plain refresh) keeps the bound offer and the
 *   deterministic price order.
 */

/** The confirmed reservation (or, failing that, the selection) a search compares against. */
export interface BoundOfferReference {
  readonly offerId: string;
  readonly partyTotalMinor: number;
}

interface SearchCandidate {
  readonly id: string;
  readonly partyTotalMinor: number;
  readonly centerDistanceKm?: number;
  readonly rating?: number;
}

/** Deterministic candidate order: ascending party total, then id. */
function byPartyTotal<T extends SearchCandidate>(offers: readonly T[]): T[] {
  return [...offers].sort((a, b) => a.partyTotalMinor - b.partyTotalMinor || a.id.localeCompare(b.id));
}

export function orderSearchCandidates<T extends SearchCandidate>(
  offers: readonly T[],
  objective: ResearchSearchIntent["objective"] | null,
  bound: BoundOfferReference | undefined,
): T[] {
  if (!objective) {
    return byPartyTotal(offers);
  }
  const withoutBound = bound ? offers.filter((offer) => offer.id !== bound.offerId) : [...offers];
  if (objective === "cheaper" && bound) {
    const cheaper = withoutBound.filter((offer) => offer.partyTotalMinor < bound.partyTotalMinor);
    return byPartyTotal(cheaper.length > 0 ? cheaper : withoutBound);
  }
  if (objective === "better_location") {
    return withoutBound.sort(
      (a, b) =>
        (a.centerDistanceKm ?? Number.POSITIVE_INFINITY) -
          (b.centerDistanceKm ?? Number.POSITIVE_INFINITY) ||
        a.partyTotalMinor - b.partyTotalMinor ||
        a.id.localeCompare(b.id),
    );
  }
  if (objective === "higher_rating") {
    return withoutBound.sort(
      (a, b) =>
        (b.rating ?? 0) - (a.rating ?? 0) ||
        a.partyTotalMinor - b.partyTotalMinor ||
        a.id.localeCompare(b.id),
    );
  }
  // `match_preferences` is a plain refresh, not an alternative search: the
  // current offer stays in the list.
  return byPartyTotal(offers);
}
