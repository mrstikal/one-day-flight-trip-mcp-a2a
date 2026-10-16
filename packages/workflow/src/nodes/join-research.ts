import { InvalidUpdateError, Overwrite } from "@langchain/langgraph";
import { researchRunKey } from "@odft/contracts";
import {
  computeResearchGate,
  latestResultPerDomain,
  retryableDomains,
} from "@odft/domain";
import type { ResearchDomainResult } from "../state/research-reducer.js";
import type { TravelState, TravelUpdate } from "../travel/state.js";

/**
 * Phase 09 join (03 section 4): the serial barrier after the research superstep.
 *
 * It verifies the full expected key set (a missing scheduled result is a typed
 * failure, never a silent pass), retains the newest usable result per domain
 * whose fingerprint still matches (pruning stale scopes with a deliberate
 * `Overwrite`), computes the bounded retry scope for retryable domains, and
 * gates the necessary domains before a decision is prepared.
 */
export function joinResearchNode(state: TravelState): TravelUpdate {
  const missing = state.requiredDomains.filter(
    (domain) => state.researchResults[researchRunKey(state.researchRunId, domain)] === undefined,
  );
  if (missing.length > 0) {
    throw new InvalidUpdateError(
      `join_research is missing scheduled domain results: ${missing.join(", ")}`,
    );
  }
  const current = state.requiredDomains.map(
    (domain) =>
      state.researchResults[researchRunKey(state.researchRunId, domain)] as ResearchDomainResult,
  );
  const retained = pruneResearchResults(
    state.researchResults,
    state.researchInputFingerprints,
    new Set(state.requiredDomains.map((domain) => researchRunKey(state.researchRunId, domain))),
  );

  const retry = retryableDomains({
    results: current,
    attempts: state.researchAttempts,
  });
  if (retry.length > 0) {
    return {
      researchResults: new Overwrite(retained),
      failedDomains: retry,
      researchRetryPending: true,
      researchStatus: "pending",
    };
  }

  const gate = computeResearchGate({
    results: latestResultPerDomain(retained),
    nextDecisionKind: state.nextDecisionKind,
    requiredDomains: state.requiredDomains,
  });
  if (gate.status === "failed") {
    return {
      researchResults: new Overwrite(retained),
      researchStatus: "failed",
      researchFailedDomains: gate.blockingDomains,
      researchReason: gate.reason,
      nextDecisionKind: "recovery",
      gate: "research_failed",
      researchRetryPending: false,
      failedDomains: [],
    };
  }
  return {
    researchResults: new Overwrite(retained),
    researchStatus: gate.status,
    researchFailedDomains: [],
    researchReason: null,
    researchRetryPending: false,
    failedDomains: [],
  };
}

/**
 * Bounded map: the current run scope's results (evidence for the retry/join)
 * plus the newest `ok` result per domain whose fingerprint still matches. Old
 * scopes are dropped, so the checkpoint never grows with every refresh.
 */
function pruneResearchResults(
  results: Readonly<Record<string, ResearchDomainResult>>,
  fingerprints: Readonly<Record<string, string>>,
  currentKeys: ReadonlySet<string>,
): Record<string, ResearchDomainResult> {
  const best = new Map<string, { key: string; result: ResearchDomainResult }>();
  for (const [key, result] of Object.entries(results)) {
    if (result.status === "ok" && result.fingerprint === fingerprints[result.domain]) {
      best.set(result.domain, { key, result });
    }
  }
  const kept: Record<string, ResearchDomainResult> = {};
  for (const { key, result } of best.values()) {
    kept[key] = result;
  }
  for (const [key, result] of Object.entries(results)) {
    if (currentKeys.has(key)) {
      kept[key] = result;
    }
  }
  return kept;
}

/** Router after the join: bounded retry, an explicit recovery decision, or rank. */
export function routeAfterJoin(state: TravelState): string {
  if (state.researchRetryPending) {
    return "dispatch_research";
  }
  if (state.researchStatus === "failed") {
    return "prepare_decision";
  }
  return "rank_recommendations";
}