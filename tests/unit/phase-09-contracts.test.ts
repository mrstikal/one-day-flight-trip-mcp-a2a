import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRIP_PREFERENCES,
  publicInspectorSchema,
  technicalCancelApiRequestSchema,
  tripProjectionSchema,
  tripSummarySchema,
} from "@odft/contracts";

/**
 * Phase 09 contract tests: history projection fields, the cancel control
 * request, and the communication-inspector sections. Every new field is safe
 * by construction (identities, lifecycle states, one-line summaries) — no
 * prompts, payloads, tokens, or endpoints can validate.
 */

function baseProjection() {
  return {
    trip: {
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      userName: "Ada Lovelace",
      revision: 1,
      adults: 2,
      originAirportId: "ourairports:123",
      destinationCityId: "geonames:456",
      destinationCountryKey: "IT",
      sightseeingDate: "2026-12-01",
      travelVariant: "one_night",
      preferences: DEFAULT_TRIP_PREFERENCES,
      workflowStatus: "ready",
      recoveryRequired: false,
      recoveryOperationId: null,
      engine: "langgraph",
      archivedAt: null,
      archiveReason: null,
    },
    operations: [],
    pendingDecision: null,
    flights: {
      routeStatus: "PENDING",
      routeReasons: [],
      alternatives: [],
      scheduleStatus: "PENDING",
      scheduleReasons: [],
      scheduleExplanation: null,
      offers: [],
      oneNightAvailable: false,
    },
    selections: {
      flights: { offerId: null, booked: false },
      hotel: { offerId: null, booked: false },
    },
    hotel: [],
    meals: [],
    program: null,
    serviceLevels: {
      hotel: { level: "standard", inherited: true },
      breakfast: { level: "standard", inherited: true },
      lunch: { level: "standard", inherited: true },
      dinner: { level: "standard", inherited: true },
    },
    searchObjectives: { hotel: null, breakfast: null, lunch: null, dinner: null },
    research: null,
    proposal: null,
    reservation: null,
    reservations: [],
    conversation: [],
    clarification: null,
    itinerary: null,
    routeChange: null,
    inspector: null,
    display: { aiMode: "fixture", demoControlsEnabled: false, mapTileUrl: null },
    historyReadOnly: false,
    capabilities: { canModify: true },
  };
}

describe("phase 09 history projection", () => {
  it("requires historyReadOnly and capabilities.canModify on every projection", () => {
    const parsed = tripProjectionSchema.parse(baseProjection());
    expect(parsed.historyReadOnly).toBe(false);
    expect(parsed.capabilities.canModify).toBe(true);
    const without = tripProjectionSchema.safeParse({
      ...baseProjection(),
      historyReadOnly: undefined,
    });
    expect(without.success).toBe(false);
  });

  it("carries archived trips as read-only history on the trip summary", () => {
    const parsed = tripSummarySchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      userName: "Ada Lovelace",
      adults: 2,
      originAirportId: "ourairports:123",
      destinationCityId: "geonames:456",
      destinationCountryKey: "IT",
      sightseeingDate: "2026-12-01",
      travelVariant: "one_night",
      preferences: DEFAULT_TRIP_PREFERENCES,
      workflowStatus: "ready",
      recoveryRequired: false,
      recoveryOperationId: null,
      revision: 3,
      archivedAt: "2026-10-18T00:00:00.000Z",
      archiveReason: "retention policy",
    });
    expect(parsed.archivedAt).toBe("2026-10-18T00:00:00.000Z");
  });
});

describe("phase 09 cancel control request", () => {
  it("accepts an empty body (the BFF generates the control request id)", () => {
    const parsed = technicalCancelApiRequestSchema.parse({ expectedRevision: 2 });
    expect(parsed.controlRequestId).toBeUndefined();
    expect(parsed.expectedRevision).toBe(2);
  });

  it("rejects unknown fields", () => {
    expect(
      technicalCancelApiRequestSchema.safeParse({
        expectedRevision: 2,
        operationId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
  });
});

describe("phase 09 communication inspector", () => {
  function baseInspector() {
    return {
      scenarioMode: "normal",
      graph: null,
      nodes: [],
      operations: [],
      checkpoints: [],
      llmCalls: [],
      llmCostTotalUsd: "0",
      voiceCalls: [],
      faults: [],
      events: [],
      protocolObservations: [],
      communications: [],
      mcpCalls: [],
      timeline: [],
    };
  }

  it("defaults the new sections to empty arrays", () => {
    const parsed = publicInspectorSchema.parse(baseInspector());
    expect(parsed.communications).toEqual([]);
    expect(parsed.mcpCalls).toEqual([]);
    expect(parsed.timeline).toEqual([]);
  });

  it("parses a communication row with a cancel outcome and rejects a wrong edge", () => {
    const parsed = publicInspectorSchema.parse({
      ...baseInspector(),
      communications: [
        {
          edge: "a2a",
          agentIdentity: "flight-agent",
          skillId: "flight.recommend.v1",
          delegationId: "33333333-3333-4333-8333-333333333333",
          taskState: "working",
          delegationStatus: "revoked",
          failureCategory: null,
          durationMs: 1200,
          attempt: 1,
          cancellationState: "acknowledged",
          createdAt: "2026-10-18T00:00:00.000Z",
          updatedAt: "2026-10-18T00:01:00.000Z",
        },
      ],
      mcpCalls: [
        {
          edge: "mcp",
          name: "search_airports",
          kind: "tool_call",
          status: "ok",
          failureCategory: null,
          durationMs: 40,
          occurredAt: "2026-10-18T00:00:00.000Z",
        },
      ],
      timeline: [
        {
          edge: "a2a",
          kind: "task_completed",
          source: "flight-agent",
          operationId: null,
          summary: "recommendations ready",
          at: "2026-10-18T00:00:00.000Z",
        },
      ],
    });
    // A wrong edge literal is rejected (never rendered as a communication).
    expect(
      publicInspectorSchema.safeParse({
        ...baseInspector(),
        communications: [
          { ...parsed.communications[0], edge: "mcp" },
        ],
      }).success,
    ).toBe(false);
    expect(parsed.communications.length).toBe(1);
    expect(parsed.communications[0]?.cancellationState).toBe("acknowledged");
    expect(parsed.mcpCalls.length).toBe(1);
    expect(parsed.timeline[0]?.edge).toBe("a2a");
  });
});
