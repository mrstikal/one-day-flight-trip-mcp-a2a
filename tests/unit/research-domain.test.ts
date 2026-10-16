import { describe, expect, it } from "vitest";
import { InvalidUpdateError } from "@langchain/langgraph";
import {
  acceptRecommendationReorder,
  computeAffectedDomains,
  computeResearchGate,
  latestResultPerDomain,
  rankDeterministically,
  retryableDomains,
  researchRunIdFor,
} from "@odft/domain";
import {
  travelResearchResultsValue,
  type ResearchDomainResult,
} from "@odft/workflow";
import { joinResearchNode, routeAfterJoin } from "../../packages/workflow/src/nodes/join-research.js";
import { routeAfterDispatch } from "../../packages/workflow/src/nodes/dispatch-research.js";
import { routeAfterRank } from "../../packages/workflow/src/nodes/rank-recommendations.js";
import type { TravelState } from "../../packages/workflow/src/travel/state.js";

/** Phase 09 unit coverage: affected domains, retry scope, gate, reducer, routers. */

function result(partial: Partial<ResearchDomainResult> & { domain: ResearchDomainResult["domain"] }): ResearchDomainResult {
  return {
    status: "ok",
    fingerprint: "a".repeat(64),
    artifactId: null,
    attempt: 1,
    simulatedFailure: false,
    reason: null,
    offerIds: [],
    ...partial,
  };
}

function travelState(partial: Record<string, unknown>): TravelState {
  return partial as TravelState;
}

describe("computeAffectedDomains (T-IT-RED scope)", () => {
  const fingerprints = {
    hotel: "1".repeat(64),
    breakfast: "2".repeat(64),
    lunch: "3".repeat(64),
    dinner: "4".repeat(64),
    attractions: "5".repeat(64),
    events: "6".repeat(64),
  };

  it("sends only the domain whose fingerprint changed", () => {
    const prior = {
      "op:r1:hotel": result({ domain: "hotel", fingerprint: fingerprints.hotel }),
      "op:r1:breakfast": result({ domain: "breakfast", fingerprint: fingerprints.breakfast }),
      "op:r1:lunch": result({ domain: "lunch", fingerprint: fingerprints.lunch }),
      "op:r1:dinner": result({ domain: "dinner", fingerprint: fingerprints.dinner }),
      "op:r1:attractions": result({
        domain: "attractions",
        fingerprint: fingerprints.attractions,
      }),
      "op:r1:events": result({ domain: "events", fingerprint: fingerprints.events }),
    };
    const current = { ...fingerprints, dinner: "9".repeat(64) };
    expect(computeAffectedDomains({ priorResults: prior, currentFingerprints: current })).toEqual([
      "dinner",
    ]);
  });

  it("treats a non-ok prior result as affected", () => {
    const prior = {
      "op:r1:hotel": result({
        domain: "hotel",
        status: "retryable_error",
        fingerprint: fingerprints.hotel,
      }),
    };
    expect(
      computeAffectedDomains({ priorResults: prior, currentFingerprints: fingerprints }),
    ).toEqual(["hotel", "breakfast", "lunch", "dinner", "attractions", "events"]);
  });

  it("keeps the newest result per domain from the keyed map", () => {
    const latest = latestResultPerDomain({
      "op:r1:hotel": result({ domain: "hotel", fingerprint: "1".repeat(64), attempt: 1 }),
      "op:r2:hotel": result({ domain: "hotel", fingerprint: "2".repeat(64), attempt: 2 }),
    });
    expect(latest.hotel?.attempt).toBe(2);
    expect(latest.hotel?.fingerprint).toBe("2".repeat(64));
  });
});

describe("bounded retry scope", () => {
  it("retries only retryable domains with an attempt left", () => {
    expect(researchRunIdFor("op-1", 2)).toBe("op-1:r2");
    expect(
      retryableDomains({
        results: [
          { domain: "hotel", status: "retryable_error" },
          { domain: "dinner", status: "unavailable" },
          { domain: "lunch", status: "retryable_error" },
        ],
        attempts: { hotel: 1, lunch: 2 },
      }),
    ).toEqual(["hotel"]);
  });
});

describe("necessary-domain gate", () => {
  it("blocks on a necessary domain and explains the gap", () => {
    const gate = computeResearchGate({
      results: {
        hotel: { status: "unavailable" },
        breakfast: { status: "ok" },
        lunch: { status: "ok" },
      },
      nextDecisionKind: "hotel_choice",
      requiredDomains: ["hotel"],
    });
    expect(gate.status).toBe("failed");
    expect(gate.blockingDomains).toEqual(["hotel"]);
    expect(gate.reason).toContain("hotel");
  });

  it("treats a failed optional domain as partial, not blocking", () => {
    const gate = computeResearchGate({
      results: {
        hotel: { status: "ok" },
        breakfast: { status: "ok" },
        lunch: { status: "ok" },
        dinner: { status: "unavailable" },
      },
      nextDecisionKind: "hotel_choice",
      requiredDomains: ["dinner"],
    });
    expect(gate.status).toBe("partial");
    expect(gate.blockingDomains).toEqual([]);
  });

  it("requires activities for the program choices decision", () => {
    const gate = computeResearchGate({
      results: {
        breakfast: { status: "ok" },
        lunch: { status: "ok" },
        attractions: { status: "retryable_error" },
      },
      nextDecisionKind: "program_choices",
      requiredDomains: ["attractions"],
    });
    expect(gate.status).toBe("failed");
    expect(gate.blockingDomains).toEqual(["attractions"]);
  });
});

describe("deterministic ranking and bounded AI reorder", () => {
  it("orders by party total then id", () => {
    expect(
      rankDeterministically([
        { id: "b", partyTotalMinor: 200 },
        { id: "a", partyTotalMinor: 100 },
        { id: "c", partyTotalMinor: 100 },
      ]),
    ).toEqual(["a", "c", "b"]);
  });

  it("accepts a permutation of supplied ids and appends omitted ones", () => {
    expect(
      acceptRecommendationReorder(
        { rankedOfferIds: ["b"], reasons: [{ offerId: "b", explanation: "best value" }] },
        ["a", "b"],
      ),
    ).toEqual(["b", "a"]);
  });

  it("rejects unknown ids, duplicates, and reasons about unsupplied offers", () => {
    expect(
      acceptRecommendationReorder({ rankedOfferIds: ["x"], reasons: [] }, ["a", "b"]),
    ).toBeNull();
    expect(
      acceptRecommendationReorder({ rankedOfferIds: ["a", "a"], reasons: [] }, ["a", "b"]),
    ).toBeNull();
    expect(
      acceptRecommendationReorder(
        { rankedOfferIds: ["a"], reasons: [{ offerId: "x", explanation: "cheapest" }] },
        ["a", "b"],
      ),
    ).toBeNull();
  });
});

describe("keyed research reducer", () => {
  const reduce = travelResearchResultsValue.reducer as (
    current: Record<string, ResearchDomainResult>,
    next: Record<string, ResearchDomainResult>,
  ) => Record<string, ResearchDomainResult>;

  it("merges unique scope keys and accepts an identical same-key write", () => {
    const first = reduce({}, { "op:r1:hotel": result({ domain: "hotel" }) });
    const second = reduce(first, { "op:r1:dinner": result({ domain: "dinner" }) });
    expect(Object.keys(second)).toEqual(["op:r1:hotel", "op:r1:dinner"]);
    const identical = reduce(second, { "op:r1:hotel": result({ domain: "hotel" }) });
    expect(identical["op:r1:hotel"]?.domain).toBe("hotel");
  });

  it("rejects a conflicting same-key write", () => {
    const first = reduce({}, { "op:r1:hotel": result({ domain: "hotel" }) });
    expect(() =>
      reduce(first, {
        "op:r1:hotel": result({ domain: "hotel", status: "unavailable" }),
      }),
    ).toThrow(InvalidUpdateError);
  });
});

describe("join_research", () => {
  const base = {
    tripId: "trip",
    operationId: "op",
    researchRunId: "op:r1",
    requiredDomains: ["hotel", "dinner"],
    researchInputFingerprints: {
      hotel: "1".repeat(64),
      dinner: "4".repeat(64),
      breakfast: "2".repeat(64),
      lunch: "3".repeat(64),
      attractions: "5".repeat(64),
      events: "6".repeat(64),
    },
    researchAttempts: { hotel: 1, dinner: 1 },
    researchRound: 1,
    nextDecisionKind: "hotel_choice" as const,
  };

  it("fails when a scheduled result is missing", () => {
    expect(() =>
      joinResearchNode(
        travelState({
          ...base,
          researchResults: { "op:r1:hotel": result({ domain: "hotel" }) },
        }),
      ),
    ).toThrow(/missing scheduled domain results/);
  });

  it("opens a bounded retry scope for a retryable domain", () => {
    const update = joinResearchNode(
      travelState({
        ...base,
        researchResults: {
          "op:r1:hotel": result({
            domain: "hotel",
            status: "retryable_error",
            fingerprint: base.researchInputFingerprints.hotel,
          }),
          "op:r1:dinner": result({
            domain: "dinner",
            fingerprint: base.researchInputFingerprints.dinner,
          }),
        },
      }),
    );
    expect(update.failedDomains).toEqual(["hotel"]);
    expect(update.researchRetryPending).toBe(true);
    expect(routeAfterJoin(travelState({ ...base, ...update, researchRetryPending: true }))).toBe(
      "dispatch_research",
    );
  });

  it("routes a necessary unavailable domain to a recovery decision", () => {
    const update = joinResearchNode(
      travelState({
        ...base,
        requiredDomains: ["hotel"],
        researchResults: {
          "op:r1:hotel": result({
            domain: "hotel",
            status: "unavailable",
            fingerprint: base.researchInputFingerprints.hotel,
            reason: "Simulated failure: no compatible hotels.",
          }),
          "op:r0:breakfast": result({
            domain: "breakfast",
            fingerprint: base.researchInputFingerprints.breakfast,
          }),
          "op:r0:lunch": result({
            domain: "lunch",
            fingerprint: base.researchInputFingerprints.lunch,
          }),
        },
      }),
    );
    expect(update.researchStatus).toBe("failed");
    expect(update.researchFailedDomains).toEqual(["hotel"]);
    expect(update.nextDecisionKind).toBe("recovery");
    expect(update.gate).toBe("research_failed");
    expect(routeAfterJoin(travelState({ ...base, ...update, researchRetryPending: false }))).toBe(
      "prepare_decision",
    );
  });

  it("keeps only the matching-fingerprint results and ranks otherwise", () => {
    const update = joinResearchNode(
      travelState({
        ...base,
        researchResults: {
          "op:r0:hotel": result({
            domain: "hotel",
            fingerprint: "9".repeat(64),
          }),
          "op:r1:hotel": result({
            domain: "hotel",
            fingerprint: base.researchInputFingerprints.hotel,
          }),
          "op:r1:dinner": result({
            domain: "dinner",
            fingerprint: base.researchInputFingerprints.dinner,
          }),
          "op:r0:breakfast": result({
            domain: "breakfast",
            fingerprint: base.researchInputFingerprints.breakfast,
          }),
          "op:r0:lunch": result({
            domain: "lunch",
            fingerprint: base.researchInputFingerprints.lunch,
          }),
        },
      }),
    );
    const merged = (
      update.researchResults as unknown as {
        value: Record<string, ResearchDomainResult>;
      }
    ).value;
    expect(merged["op:r0:hotel"]).toBeUndefined();
    expect(merged["op:r1:hotel"]).toBeDefined();
    expect(update.researchStatus).toBe("ok");
    expect(routeAfterJoin(travelState({ ...base, ...update, researchRetryPending: false }))).toBe(
      "rank_recommendations",
    );
  });
});

describe("dispatch and rank routers", () => {
  it("continues directly when no domain is affected", () => {
    expect(routeAfterDispatch(travelState({ dispatchMode: "none" }))).toBe(
      "rank_recommendations",
    );
  });

  it("fans out one Send per affected domain with its fingerprint", () => {
    const sends = routeAfterDispatch(
      travelState({
        dispatchMode: "fanout",
        tripId: "trip",
        operationId: "op",
        researchRunId: "op:r1",
        requiredDomains: ["hotel", "dinner"],
        researchAttempts: { hotel: 1, dinner: 2 },
        researchInputFingerprints: {
          hotel: "1".repeat(64),
          dinner: "4".repeat(64),
        },
      }),
    );
    expect(Array.isArray(sends)).toBe(true);
    const payloads = (sends as { args: Record<string, unknown> }[]).map((send) => send.args);
    expect(payloads).toEqual([
      {
        tripId: "trip",
        operationId: "op",
        domain: "hotel",
        researchRunId: "op:r1",
        attempt: 1,
        inputFingerprint: "1".repeat(64),
      },
      {
        tripId: "trip",
        operationId: "op",
        domain: "dinner",
        researchRunId: "op:r1",
        attempt: 2,
        inputFingerprint: "4".repeat(64),
      },
    ]);
  });

  it("routes ranking by the pending decision kind", () => {
    expect(routeAfterRank(travelState({ nextDecisionKind: "hotel_choice" }))).toBe(
      "prepare_decision",
    );
    expect(routeAfterRank(travelState({ nextDecisionKind: "program_choices" }))).toBe(
      "prepare_decision",
    );
    expect(routeAfterRank(travelState({ nextDecisionKind: null }))).toBe("publish_summary");
    // A preference batch that refreshed a domain continues into a fresh plan
    // (2026-10-14): an applied-program requirement change never re-opens the
    // program step.
    expect(
      routeAfterRank(travelState({ nextDecisionKind: null, nextWork: "research" })),
    ).toBe("plan_itinerary");
    expect(
      routeAfterRank(travelState({ nextDecisionKind: null, nextWork: "progress" })),
    ).toBe("publish_summary");
  });
});
