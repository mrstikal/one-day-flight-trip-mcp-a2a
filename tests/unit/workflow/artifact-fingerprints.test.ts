import { describe, expect, it } from "vitest";
import type { AgentDelegationRecord } from "@odft/persistence";
import { acceptArtifact } from "@odft/workflow";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const DELEGATION_ID = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT_ID = "44444444-4444-4444-8444-444444444444";
const BREAKFAST_HASH = "a".repeat(64);
const LUNCH_HASH = "b".repeat(64);
const BREAKFAST_INPUT = "c".repeat(64);
const LUNCH_INPUT = "d".repeat(64);

const delegation: AgentDelegationRecord = {
  id: DELEGATION_ID,
  tripId: TRIP_ID,
  originatingOperationId: OPERATION_ID,
  currentOperationId: OPERATION_ID,
  acceptedRevision: 1,
  skillId: "city-guide.research.v1",
  agentIdentity: "city-guide-agent",
  endpointUrl: "http://127.0.0.1:4403",
  cardVersion: "1.0.0",
  snapshotId: SNAPSHOT_ID,
  inputFingerprint: BREAKFAST_INPUT,
  scope: {
    domains: ["breakfast", "lunch"],
    snapshotId: SNAPSHOT_ID,
    objective: null,
    levelOverride: null,
    allowRouteValidation: false,
    allowItinerary: false,
  },
  taskId: "55555555-5555-4555-8555-555555555555",
  contextId: "66666666-6666-4666-8666-666666666666",
  status: "working",
  deadlineAt: null,
  attempt: 1,
  revokedAt: null,
  revokeReason: null,
  acceptedArtifactHash: null,
  cancellationRequestedAt: null,
  cancellationState: null,
  cancellationAttempts: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function artifact(breakfastHash: string, includeLunch: boolean, includeBreakfast = true): unknown {
  return {
    correlation: {
      schemaVersion: 1,
      skillId: "city-guide.research.v1",
      tripId: TRIP_ID,
      operationId: OPERATION_ID,
      acceptedRevision: 1,
      delegationId: DELEGATION_ID,
      traceId: "trace-1",
      snapshotId: SNAPSHOT_ID,
      scenarioKey: "lisbon-2026",
      inputFingerprint: BREAKFAST_INPUT,
      domainFingerprints: {
        ...(includeBreakfast ? { breakfast: breakfastHash } : {}),
        ...(includeLunch ? { lunch: LUNCH_HASH } : {}),
      },
    },
    outcomes: [
      {
        domain: "breakfast",
        status: "ok",
        rankedOfferIds: ["restaurant:breakfast-1"],
        inputFingerprint: BREAKFAST_INPUT,
        reason: null,
        simulatedFailure: false,
      },
      {
        domain: "lunch",
        status: "unavailable",
        rankedOfferIds: [],
        inputFingerprint: LUNCH_INPUT,
        reason: "the provider is unavailable",
        simulatedFailure: false,
      },
    ],
    findings: [],
  };
}

function accept(value: unknown): unknown {
  return acceptArtifact({
    artifact: value,
    delegation,
    operationId: OPERATION_ID,
    acceptedRevision: 1,
    expectedDomainFingerprints: {
      breakfast: BREAKFAST_HASH,
      lunch: LUNCH_HASH,
    },
  });
}

describe("artifact domain fingerprints", () => {
  it("accepts a partial artifact whose failed domain has no page hash", () => {
    // A thrown MCP call yields `domainHash: null` and omits the domain from
    // correlation.domainFingerprints; the successful sibling must survive.
    expect(accept(artifact(BREAKFAST_HASH, false))).toBeDefined();
  });

  it("rejects a present domain hash that differs from the snapshot manifest", () => {
    expect(accept(artifact("e".repeat(64), true))).toBeUndefined();
  });

  it("rejects a successful outcome that omits its snapshot hash", () => {
    expect(accept(artifact(BREAKFAST_HASH, false, false))).toBeUndefined();
  });
});
