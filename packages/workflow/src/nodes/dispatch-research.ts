import { Send } from "@langchain/langgraph";
import { RESEARCH_DOMAINS } from "@odft/contracts";
import { computeAffectedDomains, latestResultPerDomain, researchRunIdFor } from "@odft/domain";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 09 dispatch (03 section 4): a serial node that
 *
 * 1. re-runs the idempotent `ensureDomains` materialization (a no-op after the
 *    serial `ensure_domains` node, so the snapshot never changes here),
 * 2. computes the affected domains from the deterministic per-domain research
 *    input fingerprints (a dinner change never reruns breakfast/lunch),
 * 3. opens one new research-run scope and fans the affected domains out through
 *    `Send`.
 *
 * Zero affected domains continue directly to `rank_recommendations` with the
 * retained results, so no dangling fan-in is ever created.
 */
export async function dispatchResearchNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  await ports.runEffect("dispatch_research", "ensure", () => ports.ensureDomains(state.tripId));
  const inputs = await ports.loadResearchInputs(
    state.tripId,
    state.operationId,
    state.searchIntent,
  );

  // A retry dispatch sends exactly the retryable domains `join_research` named —
  // never a deterministically unavailable sibling. A normal dispatch recomputes
  // the affected set from the research input fingerprints, plus any explicitly
  // targeted search domain that has no usable result yet (Phase 11).
  const fingerprintAffected =
    state.failedDomains.length > 0
      ? RESEARCH_DOMAINS.filter((domain) => state.failedDomains.includes(domain))
      : computeAffectedDomains({
          priorResults: state.researchResults,
          currentFingerprints: inputs.fingerprints,
        });
  const targeted = state.searchTargetDomains.filter(
    (domain) => latestResultPerDomain(state.researchResults)[domain]?.status !== "ok",
  );
  const affected = RESEARCH_DOMAINS.filter(
    (domain) => fingerprintAffected.includes(domain) || targeted.includes(domain),
  );

  if (affected.length === 0) {
    return {
      dispatchMode: "none",
      requiredDomains: [],
      researchRetryPending: false,
      failedDomains: [],
      researchInputFingerprints: inputs.fingerprints,
    };
  }

  const round = state.researchRound + 1;
  const attempts: Record<string, number> = { ...state.researchAttempts };
  for (const domain of affected) {
    attempts[domain] = (attempts[domain] ?? 0) + 1;
  }
  return {
    dispatchMode: "fanout",
    researchRunId: researchRunIdFor(state.operationId, round),
    researchRound: round,
    requiredDomains: affected,
    researchAttempts: attempts,
    researchRetryPending: false,
    failedDomains: [],
    researchInputFingerprints: inputs.fingerprints,
    researchStatus: "pending",
    researchFailedDomains: [],
    researchReason: null,
  };
}

/**
 * Router after dispatch: fan out one `Send` per affected domain, or continue
 * directly with the retained results. The payload carries only refs and the
 * deterministic input fingerprint the task must store with its result.
 */
export function routeAfterDispatch(state: TravelState): string | Send[] {
  if (state.dispatchMode !== "fanout" || state.requiredDomains.length === 0) {
    return "rank_recommendations";
  }
  return state.requiredDomains.map(
    (domain) =>
      new Send("research_domain", {
        tripId: state.tripId,
        operationId: state.operationId,
        domain,
        researchRunId: state.researchRunId,
        attempt: state.researchAttempts[domain] ?? 1,
        inputFingerprint: state.researchInputFingerprints[domain],
        searchIntent: state.searchIntent,
      }),
  );
}