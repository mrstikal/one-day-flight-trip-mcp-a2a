import { describe, expect, it } from "vitest";
import {
  AGENT_ARTIFACT_MEDIA_TYPES,
  AGENT_ARTIFACT_SCHEMA_VERSION,
  DECISION_ALLOWED_ACTIONS,
  agentFailureCategorySchema,
  agentInputRequestSchema,
  agentTaskRequestSchema,
  coordinatorRunDataSchema,
  decisionEngineBindingSchema,
  errorCodeSchema,
  flightRecommendationsSchema,
  operationRecordSchema,
  pendingDecisionSchema,
  protocolObservationSchema,
  tripSummarySchema,
} from "@odft/contracts";

/**
 * Phase 03 contract tests: SDK-independent artifact/envelope/task/observation
 * schemas and the engine-aware decision/operation bindings.
 */

const fingerprint = (char: string): string => char.repeat(64);

function correlation() {
  return {
    schemaVersion: AGENT_ARTIFACT_SCHEMA_VERSION,
    skillId: "flight.recommend.v1" as const,
    tripId: "11111111-1111-4111-8111-111111111111",
    operationId: "22222222-2222-4222-8222-222222222222",
    acceptedRevision: 3,
    delegationId: "33333333-3333-4333-8333-333333333333",
    traceId: "trace-1",
    snapshotId: "44444444-4444-4444-8444-444444444444",
    scenarioKey: "scenario-1",
    inputFingerprint: fingerprint("a"),
    domainFingerprints: { hotel: fingerprint("b") },
  };
}

describe("agent artifact contracts", () => {
  it("parses a valid versioned flight-recommendation artifact", () => {
    const parsed = flightRecommendationsSchema.parse({
      correlation: correlation(),
      rankedCombinationIds: ["combo-1", "combo-2"],
      findings: [],
      priceFacts: [],
      explanations: ["ranked by price"],
      reorderNote: null,
    });
    expect(parsed.rankedCombinationIds).toHaveLength(2);
  });

  it("rejects unknown fields and malformed fingerprints (strict schemas)", () => {
    expect(() =>
      flightRecommendationsSchema.parse({
        correlation: correlation(),
        rankedCombinationIds: ["combo-1"],
        findings: [],
        priceFacts: [],
        explanations: [],
        reorderNote: null,
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      flightRecommendationsSchema.parse({
        correlation: { ...correlation(), inputFingerprint: "short" },
        rankedCombinationIds: ["combo-1"],
        findings: [],
        priceFacts: [],
        explanations: [],
        reorderNote: null,
      }),
    ).toThrow();
  });

  it("exposes stable versioned media types", () => {
    expect(AGENT_ARTIFACT_MEDIA_TYPES.flightRecommendations).toBe(
      "application/vnd.odft.flight-recommendations.v1+json",
    );
    expect(AGENT_ARTIFACT_MEDIA_TYPES.agentInputRequest).toBe(
      "application/vnd.odft.agent-input-request.v1+json",
    );
  });

  it("requires a bounded question with finite options and an expiry", () => {
    const request = {
      correlation: correlation(),
      requestId: "q-1",
      taskId: "task-1",
      contextId: "ctx-1",
      inputGeneration: 1,
      reason: "ambiguous_payload",
      question: "Which option?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      expiresAt: new Date().toISOString(),
      requestHash: fingerprint("c"),
    };
    expect(agentInputRequestSchema.parse(request).options).toHaveLength(2);
    expect(() =>
      agentInputRequestSchema.parse({ ...request, options: [{ id: "a", label: "A" }] }),
    ).toThrow();
  });

  it("enumerates exactly the ten safe failure categories", () => {
    expect(agentFailureCategorySchema.options).toEqual([
      "AGENT_UNAVAILABLE",
      "AGENT_TIMEOUT",
      "AGENT_RESTARTED",
      "MCP_UNAVAILABLE",
      "MCP_TIMEOUT",
      "INVALID_ARTIFACT",
      "TASK_BUDGET_EXCEEDED",
      "INPUT_EXPIRED",
      "DELEGATION_REVOKED",
      "STALE_AGENT_RESULT",
    ]);
    for (const category of agentFailureCategorySchema.options) {
      expect(errorCodeSchema.options).toContain(category);
    }
  });

  it("binds task requests to an explicit frozen snapshot and limits", () => {
    const parsed = agentTaskRequestSchema.parse({
      schemaVersion: 1,
      skillId: "accommodation.recommend.v1",
      tripId: "11111111-1111-4111-8111-111111111111",
      operationId: "22222222-2222-4222-8222-222222222222",
      acceptedRevision: 1,
      delegationId: "33333333-3333-4333-8333-333333333333",
      traceId: "trace-1",
      snapshot: {
        snapshotId: "44444444-4444-4444-8444-444444444444",
        scenarioKey: "scenario-1",
        routeApprovalFingerprint: fingerprint("a"),
        scheduleApprovalFingerprint: fingerprint("b"),
        domainFingerprints: { hotel: fingerprint("c") },
      },
      inputFingerprint: fingerprint("d"),
      requestedDomains: ["hotel"],
      travelVariant: "one_night",
      adults: 2,
      sightseeingDate: "2026-12-01",
      effectiveLevel: "standard",
      selectedOfferIds: [],
      confirmedOfferIds: [],
      preservationConstraints: [],
      searchObjective: "preserve_level",
      queryContext: {},
      deadlineAt: new Date().toISOString(),
      limits: {
        activeTimeMs: 60_000,
        mcpInvocations: 4,
        llmTransportAttempts: 2,
        maxTaskCostUsd: 1,
      },
      preferences: {
        travelVariant: "one_night",
        defaultServiceLevel: "standard",
        serviceOverrides: {},
        activityPace: "moderate",
        interests: { culture: 3, relaxation: 2, entertainment: 1 },
        preferredActivityTags: [],
        minimumActivityCounts: {},
      },
      continuation: null,
    });
    expect(parsed.snapshot.scenarioKey).toBe("scenario-1");
  });
});

describe("coordinator contracts", () => {
  it("validates minimal run data with partial fingerprints", () => {
    const runData = coordinatorRunDataSchema.parse({
      schemaVersion: 1,
      affectedDomains: ["hotel"],
      expectedFingerprints: { hotel: fingerprint("a") },
    });
    expect(runData.questionQueue).toEqual([]);
    expect(runData.planningAttempt).toBe(0);
  });

  it("discriminates graph vs coordinator decision bindings", () => {
    expect(
      decisionEngineBindingSchema.parse({
        engine: "langgraph",
        threadId: "thread-1",
        graphVersion: "travel-graph-v7",
        interruptId: null,
        checkpointId: null,
      }).engine,
    ).toBe("langgraph");
    expect(
      decisionEngineBindingSchema.parse({
        engine: "coordinator-v1",
        runId: "11111111-1111-4111-8111-111111111111",
        coordinatorVersion: "coordinator-v1",
      }).engine,
    ).toBe("coordinator-v1");
  });

  it("allows agent_input as a decision kind answered by choose_option", () => {
    expect(DECISION_ALLOWED_ACTIONS.agent_input).toEqual(["choose_option"]);
  });

  it("requires graph checkpoint fields for graph decisions and forbids them for coordinator decisions", () => {
    const base = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "flight_choice" as const,
      createdRevision: 1,
      sourceFingerprint: fingerprint("a"),
      allowedOfferIds: [],
      allowedOptionIds: [],
      payloadHash: fingerprint("b"),
      status: "pending" as const,
    };
    expect(() => pendingDecisionSchema.parse({ ...base, engine: "langgraph" })).toThrow(/threadId/);
    expect(
      pendingDecisionSchema.parse({
        ...base,
        engine: "langgraph",
        threadId: "thread-1",
        graphVersion: "travel-graph-v7",
      }).engine,
    ).toBe("langgraph");
    expect(() =>
      pendingDecisionSchema.parse({
        ...base,
        engine: "coordinator-v1",
        threadId: "thread-1",
        graphVersion: "travel-graph-v7",
        coordinatorRunId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow(/checkpoint identifiers/);
    expect(
      pendingDecisionSchema.parse({
        ...base,
        engine: "coordinator-v1",
        coordinatorRunId: "22222222-2222-4222-8222-222222222222",
      }).coordinatorRunId,
    ).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("defaults the engine to the coordinator on new trips and operations", () => {
    const trip = tripSummarySchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      revision: 0,
      userName: "Test",
      adults: 1,
      originAirportId: "ourairports:4408",
      destinationCityId: "geonames:3169070",
      destinationCountryKey: "IT",
      sightseeingDate: "2026-12-01",
      travelVariant: "one_night",
      preferences: {
        travelVariant: "one_night",
        defaultServiceLevel: "standard",
        serviceOverrides: {},
        activityPace: "moderate",
        interests: { culture: 3, relaxation: 2, entertainment: 1 },
        preferredActivityTags: [],
        minimumActivityCounts: {},
      },
      workflowStatus: "idle",
      recoveryRequired: false,
      recoveryOperationId: null,
    });
    expect(trip.engine).toBe("coordinator-v1");
    const operation = operationRecordSchema.parse({
      id: "33333333-3333-4333-8333-333333333333",
      tripId: "11111111-1111-4111-8111-111111111111",
      requestId: "44444444-4444-4444-8444-444444444444",
      payloadHash: fingerprint("c"),
      acceptedRevision: 0,
      status: "queued",
      attempts: 0,
    });
    expect(operation.engine).toBe("coordinator-v1");
  });
});

describe("protocol observation contract", () => {
  it("parses a safe observation and rejects unsafe extra fields", () => {
    const observation = {
      id: "11111111-1111-4111-8111-111111111111",
      source: "flight-agent" as const,
      kind: "task_completed" as const,
      correlation: {
        tripId: null,
        operationId: null,
        delegationId: null,
        taskId: "task-1",
        contextId: "ctx-1",
        traceId: null,
      },
      payload: {
        detail: null,
        failureCategory: null,
        durationMs: 42,
        status: "completed",
        counters: {},
      },
      occurredAt: new Date().toISOString(),
      payloadHash: fingerprint("a"),
    };
    expect(protocolObservationSchema.parse(observation).payload.durationMs).toBe(42);
    expect(() =>
      protocolObservationSchema.parse({
        ...observation,
        payload: { ...observation.payload, prompt: "secret" },
      }),
    ).toThrow();
  });
});
