import {
  RESEARCH_DOMAINS,
  type ResearchDomain,
  type ResearchDomainStatus,
} from "@odft/contracts";

/**
 * Phase 09 affected-domain computation (03 section 4).
 *
 * The dispatch node sends only the domains whose *research input fingerprint*
 * changed: a dinner override must never rerun breakfast/lunch, and an unchanged
 * refresh (e.g. an activity-pace change) yields zero affected domains so the
 * graph continues directly with the retained results.
 */

export interface DomainResearchInput {
  readonly domain: ResearchDomain;
  /** Deterministic hash of everything the ranking consumes for this domain. */
  readonly inputFingerprint: string;
}

export interface PriorDomainResult {
  readonly domain: ResearchDomain;
  readonly status: ResearchDomainStatus;
  readonly fingerprint: string;
}

/** The newest result per domain from the reducer map (keys are scoped). */
export function latestResultPerDomain<T extends PriorDomainResult>(
  results: Readonly<Record<string, T>>,
): Partial<Record<ResearchDomain, T>> {
  const latest: Partial<Record<ResearchDomain, T>> = {};
  for (const result of Object.values(results)) {
    // Insertion order of the reducer map is chronological per scope; later
    // entries win because a new run scope appends its own keys.
    latest[result.domain] = result;
  }
  return latest;
}

/**
 * A domain is affected when it has no usable prior result or its research input
 * fingerprint changed. A previous failure counts as "no usable result", so a
 * refresh (or a user retry) re-researches it; the bounded automatic retry is
 * driven separately by the explicit failed-domain set from `join_research`.
 */
export function computeAffectedDomains(input: {
  readonly priorResults: Readonly<Record<string, PriorDomainResult>>;
  readonly currentFingerprints: Readonly<Partial<Record<ResearchDomain, string>>>;
}): ResearchDomain[] {
  const latest = latestResultPerDomain(input.priorResults);
  return RESEARCH_DOMAINS.filter((domain) => {
    const fingerprint = input.currentFingerprints[domain];
    if (fingerprint === undefined) {
      return false;
    }
    const prior = latest[domain];
    if (!prior || prior.status !== "ok") {
      return true;
    }
    return prior.fingerprint !== fingerprint;
  });
}
