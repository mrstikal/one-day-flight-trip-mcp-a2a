import type { ResearchDomain } from "@odft/contracts";

/**
 * Phase 09 deterministic ranking (03 section 4).
 *
 * The deterministic filter/order runs first and stays binding. An optional
 * recommendation-role reorder may only permute the supplied candidate ids; an
 * output with unknown, duplicated, or misleading entries is rejected and the
 * deterministic order is kept.
 */

export interface RankableOffer {
  readonly id: string;
  readonly partyTotalMinor: number;
}

/**
 * Deterministic candidate order: ascending party total, then id. `eligible`
 * carries the deterministic filter result (membership, category, dates, party,
 * price); offers outside it are dropped before ordering.
 */
export function rankDeterministically(
  eligible: readonly RankableOffer[],
): string[] {
  return [...eligible]
    .sort((a, b) => a.partyTotalMinor - b.partyTotalMinor || a.id.localeCompare(b.id))
    .map((offer) => offer.id);
}

export interface RecommendationReorder {
  readonly rankedOfferIds: readonly string[];
  readonly reasons: readonly { readonly offerId: string; readonly explanation: string }[];
}

/**
 * Accept a recommendation-role reorder only when every returned id is one of
 * the supplied candidates, none is duplicated, and every reason refers to a
 * supplied candidate. Returns the accepted order (supplied ids the model omitted
 * are appended deterministically), or null when the output is invalid.
 */
export function acceptRecommendationReorder(
  output: RecommendationReorder,
  suppliedIds: readonly string[],
): string[] | null {
  const supplied = new Set(suppliedIds);
  const seen = new Set<string>();
  for (const id of output.rankedOfferIds) {
    if (!supplied.has(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);
  }
  for (const reason of output.reasons) {
    if (!supplied.has(reason.offerId)) {
      return null;
    }
  }
  return [...seen, ...suppliedIds.filter((id) => !seen.has(id))];
}

/** Domains whose ranked ids feed graph state (events stay a ref only). */
export const RANKED_RESEARCH_DOMAINS: readonly ResearchDomain[] = [
  "hotel",
  "breakfast",
  "lunch",
  "dinner",
  "attractions",
];