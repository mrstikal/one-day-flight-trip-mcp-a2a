import type { ResearchDomain, ResearchDomainStatus } from "@odft/contracts";

/**
 * Phase 09 bounded retry scope (03 section 4).
 *
 * A failed domain is retried automatically at most once per operation: the
 * retry opens a *new* research-run scope so reducer keys stay unique and only
 * the failed domains are dispatched. Attempt counting is per affected domain per
 * operation, never per node or per superstep.
 */

export const MAX_PROVIDER_ATTEMPTS_PER_DOMAIN = 2;

/** Deterministic run-scope id: replaying a dispatch recomputes the same scope. */
export function researchRunIdFor(operationId: string, round: number): string {
  return `${operationId}:r${round}`;
}

export interface DomainRunResult {
  readonly domain: ResearchDomain;
  readonly status: ResearchDomainStatus;
}

/**
 * Domains that failed with a retryable provider error and still have an attempt
 * left. `unavailable`/`unsupported` are deterministic: retrying cannot help.
 */
export function retryableDomains(input: {
  readonly results: readonly DomainRunResult[];
  readonly attempts: Readonly<Record<string, number>>;
  readonly maxAttempts?: number;
}): ResearchDomain[] {
  const max = input.maxAttempts ?? MAX_PROVIDER_ATTEMPTS_PER_DOMAIN;
  return input.results
    .filter((result) => result.status === "retryable_error")
    .map((result) => result.domain)
    .filter((domain) => (input.attempts[domain] ?? 1) < max);
}
