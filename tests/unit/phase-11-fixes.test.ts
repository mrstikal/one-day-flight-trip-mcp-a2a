import { describe, expect, it } from "vitest";
import { orderSearchCandidates } from "@odft/domain";
import { deriveOperationFrontier, projectSafeEvent } from "@odft/persistence";

/**
 * Phase 11 review-fix regressions: objective-aware alternative ranking, the
 * inspector's real execution frontier, and the new start-event allowlist.
 */

describe("alternative-search objectives (Phase 11 review fix)", () => {
  const bound = { offerId: "current", partyTotalMinor: 300 };
  const offers = [
    { id: "current", partyTotalMinor: 300, centerDistanceKm: 0.5, rating: 4.9 },
    { id: "cheap", partyTotalMinor: 200, centerDistanceKm: 3.0, rating: 3.5 },
    { id: "mid", partyTotalMinor: 280, centerDistanceKm: 1.0, rating: 4.0 },
    { id: "dear", partyTotalMinor: 400, centerDistanceKm: 0.2, rating: 4.8 },
  ];

  it("cheaper excludes the bound offer and prefers strictly cheaper ones", () => {
    expect(orderSearchCandidates(offers, "cheaper", bound).map((offer) => offer.id)).toEqual([
      "cheap",
      "mid",
    ]);
  });

  it("cheaper falls back to the category minus the bound offer when nothing is cheaper", () => {
    const expensiveBound = { offerId: "dear", partyTotalMinor: 100 };
    expect(orderSearchCandidates(offers, "cheaper", expensiveBound).map((offer) => offer.id)).toEqual(
      ["cheap", "mid", "current"],
    );
  });

  it("better_location orders by distance and never returns the bound offer", () => {
    expect(orderSearchCandidates(offers, "better_location", bound).map((offer) => offer.id)).toEqual([
      "dear",
      "mid",
      "cheap",
    ]);
  });

  it("higher_rating orders by rating and never returns the bound offer", () => {
    expect(orderSearchCandidates(offers, "higher_rating", bound).map((offer) => offer.id)).toEqual([
      "dear",
      "mid",
      "cheap",
    ]);
  });

  it("match_preferences keeps the bound offer and the deterministic price order", () => {
    expect(orderSearchCandidates(offers, "match_preferences", bound).map((offer) => offer.id)).toEqual(
      ["cheap", "mid", "current", "dear"],
    );
    expect(orderSearchCandidates(offers, null, undefined).map((offer) => offer.id)).toEqual([
      "cheap",
      "mid",
      "current",
      "dear",
    ]);
  });
});

describe("inspector execution frontier (Phase 11 review fix)", () => {
  it("marks the started-but-unfinished node of the running operation as active", () => {
    const frontier = deriveOperationFrontier(
      [
        { type: "node.started", operationId: "op2", node: "plan_itinerary" },
        { type: "node.updated", operationId: "op2", node: "review_itinerary" },
        { type: "node.started", operationId: "op2", node: "review_itinerary" },
        { type: "node.updated", operationId: "op1", node: "load_context" },
      ],
      { id: "op2", status: "running" },
    );
    expect(frontier).toEqual({ node: "plan_itinerary", status: "active" });
  });

  it("marks the frontier failed when the newest operation failed", () => {
    const frontier = deriveOperationFrontier(
      [{ type: "node.started", operationId: "op2", node: "validate_route" }],
      { id: "op2", status: "failed" },
    );
    expect(frontier).toEqual({ node: "validate_route", status: "failed" });
  });

  it("never highlights a node of a previous operation or a finished node", () => {
    expect(
      deriveOperationFrontier(
        [{ type: "node.updated", operationId: "op1", node: "load_context" }],
        { id: "op2", status: "running" },
      ),
    ).toEqual({ node: null, status: "active" });
    expect(
      deriveOperationFrontier(
        [
          { type: "node.updated", operationId: "op2", node: "plan_itinerary" },
          { type: "node.started", operationId: "op2", node: "plan_itinerary" },
        ],
        { id: "op2", status: "running" },
      ),
    ).toEqual({ node: null, status: "active" });
    expect(deriveOperationFrontier([], null)).toEqual({ node: null, status: "active" });
  });
});

describe("node start events are allowlisted (Phase 11 review fix)", () => {
  it("stores only the node name", () => {
    expect(projectSafeEvent("node.started", { node: "apply_commands", input: { secret: 1 } })).toEqual({
      node: "apply_commands",
    });
  });
});
