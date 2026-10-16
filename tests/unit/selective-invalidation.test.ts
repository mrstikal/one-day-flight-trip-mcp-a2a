import { describe, expect, it } from "vitest";
import type { DomainCommand } from "@odft/contracts";
import {
  checkPreservation,
  preservedContentDomains,
  preservedReservationServices,
  researchDomainsForChange,
  resolveInvalidation,
  type InvalidationRefs,
} from "@odft/domain";
import {
  commandChange,
  mergeResolutions,
  nextWorkFor,
  resolveCommandRouting,
  routingRefs,
} from "../../packages/workflow/src/routing/invalidation-matrix.js";
import { projectSafeEvent } from "../../packages/persistence/src/events.js";
import { TRAVEL_GRAPH_DEFINITION, TRAVEL_GRAPH_EDGE_GROUPS } from "../../packages/workflow/src/travel/graph-definition.js";
import { graphDefinitionSchema } from "@odft/contracts";

/**
 * Phase 11 invalidation matrix (03-langgraph-design.md section 10) and the safe
 * event projection (10-security-reliability.md section 8).
 */

const refs: InvalidationRefs = {
  inheritedServices: ["hotel", "breakfast", "lunch", "dinner"],
  confirmedServices: ["flights", "hotel"],
  selectedServices: ["breakfast", "lunch"],
  hasConfirmedFlight: true,
  programApplied: true,
};

describe("invalidation matrix (Phase 11)", () => {
  it("refreshes only the target meal for a dinner-only change", () => {
    const resolution = resolveInvalidation({ kind: "meal_level", meal: "dinner" }, refs);
    expect(resolution.affectedDomains).toEqual(["dinner"]);
    expect(resolution.preservedDomains).toEqual([
      "hotel",
      "breakfast",
      "lunch",
      "attractions",
      "events",
    ]);
    expect(resolution.itineraryAction).toBe("none");
    expect(resolution.requiresConfirmation).toBe(false);
  });

  it("refreshes only inherited services for a global level change", () => {
    const withOverride: InvalidationRefs = {
      ...refs,
      inheritedServices: ["breakfast", "lunch"],
    };
    expect(researchDomainsForChange({ kind: "global_service_level" }, withOverride)).toEqual([
      "breakfast",
      "lunch",
    ]);
    // An explicit hotel override keeps its category and its cached result.
    expect(researchDomainsForChange({ kind: "global_service_level" }, withOverride)).not.toContain(
      "hotel",
    );
  });

  it("reuses the inventory for a pace change (no research, itinerary rebuild)", () => {
    const resolution = resolveInvalidation({ kind: "activity_pace" }, refs);
    expect(resolution.affectedDomains).toEqual([]);
    expect(resolution.itineraryAction).toBe("propose");
    expect(resolution.preservedDomains).toContain("hotel");
  });

  it("refreshes only attractions for interests and numeric requirements", () => {
    expect(researchDomainsForChange({ kind: "interests" }, refs)).toEqual(["attractions"]);
    expect(researchDomainsForChange({ kind: "activity_requirement" }, refs)).toEqual(["attractions"]);
  });

  it("keeps a cheaper hotel search in the bound category and preserves bookings", () => {
    const resolution = resolveInvalidation(
      { kind: "search_alternatives", target: "hotel" },
      refs,
    );
    expect(resolution.affectedDomains).toEqual(["hotel"]);
    expect(resolution.nextDecisionKind).toBe("hotel_choice");
    expect(resolution.requiresConfirmation).toBe(false);
    expect(preservedReservationServices({ kind: "search_alternatives", target: "hotel" })).toEqual([
      "flights",
      "breakfast",
      "lunch",
      "dinner",
    ]);
    expect(preservedContentDomains({ kind: "search_alternatives", target: "hotel" })).toEqual([]);
  });

  it("requires explicit confirmation for a route change with confirmed reservations", () => {
    const resolution = resolveInvalidation({ kind: "route_change" }, refs);
    expect(resolution.requiresConfirmation).toBe(true);
    expect(resolution.routeChange).toBe(true);
    expect(resolution.nextDecisionKind).toBe("route_change_confirmation");
    // Without a booking the same change applies directly and only the fresh
    // feasibility stages run (never an empty confirmation card).
    const unbooked = resolveInvalidation(
      { kind: "route_change" },
      { ...refs, confirmedServices: [], selectedServices: [] },
    );
    expect(unbooked.requiresConfirmation).toBe(false);
    expect(unbooked.nextDecisionKind).toBeNull();
    expect(nextWorkFor(unbooked)).toBe("route");
    expect(
      resolveCommandRouting({
        commands: [{ type: "set_route", destinationCityId: "geonames:2988507" }],
        refs: { ...refs, confirmedServices: [], selectedServices: [] },
      }).nextWork,
    ).toBe("route");
  });

  it("preserves the flight and the hotel across a meal replacement", () => {
    expect(
      preservedReservationServices({ kind: "selected_meal_replacement", meal: "dinner" }),
    ).toEqual(["flights", "hotel"]);
    expect(preservedContentDomains({ kind: "meal_level", meal: "dinner" })).toEqual([
      "hotel",
      "breakfast",
      "lunch",
      "attractions",
      "events",
    ]);
  });

  it("checkPreservation reports a content-hash change outside the affected set", () => {
    const violations = checkPreservation({
      change: { kind: "meal_level", meal: "dinner" },
      refs,
      before: [
        { domain: "hotel", contentHash: "h1" },
        { domain: "lunch", contentHash: "l1" },
      ],
      after: [
        { domain: "hotel", contentHash: "h2" },
        { domain: "lunch", contentHash: "l1" },
      ],
      beforeReservationIds: { flights: "r1", hotel: "r2" },
      afterReservationIds: { flights: "r1", hotel: "r2" },
    });
    expect(violations.map((violation) => violation.key)).toEqual(["hotel"]);
    const clean = checkPreservation({
      change: { kind: "meal_level", meal: "dinner" },
      refs,
      before: [{ domain: "lunch", contentHash: "l1" }],
      after: [{ domain: "lunch", contentHash: "l1" }],
      beforeReservationIds: { flights: "r1" },
      afterReservationIds: { flights: "r1" },
    });
    expect(clean).toEqual([]);
  });
});

describe("command routing (Phase 11)", () => {
  const refsFor = routingRefs({
    preferences: { defaultServiceLevel: "standard", serviceOverrides: { dinner: "budget" } },
    confirmedServices: ["flights", "hotel"],
    selectedServices: [],
    hasConfirmedFlight: true,
    programApplied: true,
  });

  it("maps each command to its matrix change", () => {
    const commands: DomainCommand[] = [
      { type: "set_route", sightseeingDate: "2026-12-05" },
      { type: "set_default_service_level", level: "luxury" },
      { type: "set_service_override", service: "dinner", level: "budget" },
      { type: "set_service_override", service: "hotel", level: null },
      { type: "set_activity_pace", pace: "relaxed" },
      {
        type: "set_interests",
        interests: { culture: 1, relaxation: 1, entertainment: 1 },
        preferredTags: [],
      },
      { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
      { type: "set_budget", maxBudgetMinor: 100 },
      { type: "find_alternatives", target: "hotel", objective: "cheaper" },
      { type: "propose_selection", service: "hotel", offerId: "o" },
      { type: "set_simulation", mode: "budget_conflict" },
    ];
    expect(commands.map(commandChange)).toEqual([
      { kind: "route_change" },
      { kind: "global_service_level" },
      { kind: "meal_level", meal: "dinner" },
      { kind: "hotel_level" },
      { kind: "activity_pace" },
      { kind: "interests" },
      { kind: "activity_requirement" },
      { kind: "budget" },
      { kind: "search_alternatives", target: "hotel" },
      { kind: "selected_hotel_replacement" },
      { kind: "control" },
    ]);
  });

  it("replans directly for a pace change once a program is applied (no re-confirmation)", () => {
    const routed = resolveCommandRouting({
      commands: [{ type: "set_activity_pace", pace: "relaxed" }],
      refs: refsFor,
    });
    expect(routed.nextWork).toBe("plan");
    expect(routed.resolution.progressDecision).toBe(false);
    expect(routed.resolution.itineraryAction).toBe("propose");
    // Before a program exists the step still re-derives through progress.
    const beforeProgram = resolveCommandRouting({
      commands: [{ type: "set_activity_pace", pace: "relaxed" }],
      refs: routingRefs({
        preferences: { defaultServiceLevel: "standard", serviceOverrides: {} },
        confirmedServices: ["flights", "hotel"],
        selectedServices: [],
        hasConfirmedFlight: true,
        programApplied: false,
      }),
    });
    expect(beforeProgram.nextWork).toBe("progress");
    expect(beforeProgram.resolution.progressDecision).toBe(true);
  });

  it("refreshes attractions and replans directly for interests/requirements once a program is applied", () => {
    const commands: DomainCommand[] = [
      {
        type: "set_interests",
        interests: { culture: 1, relaxation: 1, entertainment: 1 },
        preferredTags: [],
      },
      { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
    ];
    for (const command of commands) {
      const routed = resolveCommandRouting({ commands: [command], refs: refsFor });
      expect(routed.nextWork).toBe("research");
      expect(routed.resolution.affectedDomains).toEqual(["attractions"]);
      expect(routed.resolution.itineraryAction).toBe("propose");
      expect(routed.resolution.progressDecision).toBe(false);
      // Without an applied program the step still re-derives through progress.
      const beforeProgram = resolveCommandRouting({
        commands: [command],
        refs: routingRefs({
          preferences: { defaultServiceLevel: "standard", serviceOverrides: {} },
          confirmedServices: ["flights", "hotel"],
          selectedServices: [],
          hasConfirmedFlight: true,
          programApplied: false,
        }),
      });
      expect(beforeProgram.nextWork).toBe("progress");
    }
  });

  it("routes preference changes through progress detection and searches to research", () => {
    expect(
      resolveCommandRouting({
        commands: [{ type: "set_service_override", service: "dinner", level: "luxury" }],
        refs: refsFor,
      }).nextWork,
    ).toBe("progress");
    const search = resolveCommandRouting({
      commands: [{ type: "find_alternatives", target: "hotel", objective: "cheaper" }],
      refs: refsFor,
    });
    expect(search.nextWork).toBe("research");
    expect(search.resolution.nextDecisionKind).toBe("hotel_choice");
    // An overlay/retry control re-opens the current step and never ends the run.
    expect(
      resolveCommandRouting({
        commands: [{ type: "set_simulation", mode: "invalid_itinerary" }],
        refs: refsFor,
      }).nextWork,
    ).toBe("progress");
  });

  it("routes a route change to the confirmation decision and merges batch precedence", () => {
    const route = resolveCommandRouting({
      commands: [{ type: "set_route", sightseeingDate: "2026-12-05" }],
      refs: refsFor,
    });
    expect(route.nextWork).toBe("route");
    expect(route.resolution.requiresConfirmation).toBe(true);
    expect(route.resolution.nextDecisionKind).toBe("route_change_confirmation");
    // A route change outranks a program command in the same batch.
    const mixed = resolveCommandRouting({
      commands: [
        { type: "set_route", sightseeingDate: "2026-12-05" },
        { type: "set_activity_pace", pace: "relaxed" },
      ],
      refs: refsFor,
    });
    expect(mixed.nextWork).toBe("route");
    expect(mixed.resolution.routeChange).toBe(true);

    const merged = mergeResolutions([
      resolveInvalidation({ kind: "meal_level", meal: "dinner" }, refs),
      resolveInvalidation({ kind: "search_alternatives", target: "hotel" }, refs),
    ]);
    expect(merged.nextDecisionKind).toBe("hotel_choice");
    expect(merged.affectedDomains).toEqual(["dinner", "hotel"]);
    expect(nextWorkFor(merged)).toBe("research");
  });
});

describe("graph definition registry (Phase 11)", () => {
  it("is a schema-valid definition whose edges reference known nodes", () => {
    const parsed = graphDefinitionSchema.parse(TRAVEL_GRAPH_DEFINITION);
    const known = new Set([...parsed.nodes.map((node) => node.id), "__start__", "__end__"]);
    for (const edge of parsed.edges) {
      expect(known.has(edge.from)).toBe(true);
      expect(known.has(edge.to)).toBe(true);
    }
    expect(parsed.graphVersion).toBe("travel-graph-v7");
  });

  it("declares exactly one edge group per routing node", () => {
    const groupIds = TRAVEL_GRAPH_EDGE_GROUPS.map((group) => group.from);
    expect(new Set(groupIds).size).toBe(groupIds.length);
  });
});

describe("safe event projection (Phase 11)", () => {
  it("keeps only allowlisted fields and never leaks unknown payload shapes", () => {
    const projected = projectSafeEvent("research.domain_finished", {
      domain: "hotel",
      status: "ok",
      fingerprint: "a".repeat(64),
      prompt: "SECRET PROMPT",
      rawResponse: { chainOfThought: "hidden" },
      stack: "at ...",
    });
    expect(projected).toEqual({ domain: "hotel", status: "ok", fingerprint: "a".repeat(64) });
    expect(projectSafeEvent("unknown.future.type", { anything: "value" })).toEqual({});
    expect(projectSafeEvent("node.updated", { node: "apply_commands", payload: { secret: 1 } })).toEqual(
      { node: "apply_commands" },
    );
    expect(projectSafeEvent("operation.failed", { code: "RETRYABLE_FAILURE", error: "boom" })).toEqual(
      { code: "RETRYABLE_FAILURE" },
    );
  });
});
