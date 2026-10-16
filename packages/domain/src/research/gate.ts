import { RESEARCH_DOMAINS, type ResearchDomain, type ResearchDomainStatus } from "@odft/contracts";

/**
 * Phase 09 necessary-domain gate (03 section 4).
 *
 * Successful siblings always join, but the next decision is only prepared when
 * every *necessary* domain has a usable result. The hotel is necessary until it
 * is confirmed; breakfast and lunch are always necessary for the program step;
 * activities are necessary once the program choices are the target. Dinner is
 * contractually optional (a deterministic no-slot result) and events never block.
 */

export const NECESSARY_RESEARCH_DOMAINS: readonly ResearchDomain[] = ["hotel", "breakfast", "lunch"];

export interface ResearchGateInput {
  /** Latest result per domain (only domains with a result). */
  readonly results: Readonly<Partial<Record<ResearchDomain, { readonly status: ResearchDomainStatus }>>>;
  /** The decision the run is heading to (`hotel_choice`, `program_choices`, ...). */
  readonly nextDecisionKind: string | null;
  /** Domains dispatched in the run being joined (kept small, never all six). */
  readonly requiredDomains: readonly ResearchDomain[];
}

export interface ResearchGateResult {
  readonly status: "ok" | "partial" | "failed";
  readonly blockingDomains: ResearchDomain[];
  readonly reason: string | null;
}

/** The necessary domains for the decision the run is heading to. */
export function necessaryDomainsFor(nextDecisionKind: string | null): ResearchDomain[] {
  if (nextDecisionKind === "program_choices") {
    return ["breakfast", "lunch", "attractions"];
  }
  if (nextDecisionKind === "hotel_choice" || nextDecisionKind === null) {
    return [...NECESSARY_RESEARCH_DOMAINS];
  }
  // Any other target (search-only, summary) only needs the domain it refreshes.
  return [];
}

export function computeResearchGate(input: ResearchGateInput): ResearchGateResult {
  const necessary = new Set(necessaryDomainsFor(input.nextDecisionKind));
  const blocking = RESEARCH_DOMAINS.filter((domain) => {
    if (!necessary.has(domain)) {
      return false;
    }
    const result = input.results[domain];
    return result === undefined || result.status !== "ok";
  });
  if (blocking.length > 0) {
    return {
      status: "failed",
      blockingDomains: blocking,
      reason:
        blocking[0] === "hotel"
          ? "No compatible hotel is available for the selected category."
          : `A required option is unavailable (${blocking[0]}).`,
    };
  }
  const partial = input.requiredDomains.some(
    (domain) => input.results[domain]?.status !== "ok",
  );
  return { status: partial ? "partial" : "ok", blockingDomains: [], reason: null };
}
