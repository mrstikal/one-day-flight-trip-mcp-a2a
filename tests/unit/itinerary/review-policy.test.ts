import { describe, expect, it } from "vitest";
import { DEFAULT_TRIP_PREFERENCES } from "@odft/contracts";
import { reviewerContextSchema, type ReviewerContext, type ReviewerOutput } from "@odft/ai";
import { evaluateItineraryReview } from "../../../apps/worker/src/travel/itinerary-review.js";

function context(overrides: Partial<ReviewerContext> = {}): ReviewerContext {
  return reviewerContextSchema.parse({
    role: "reviewer",
    events: [],
    metrics: {
      totalWalkingMinutes: 0,
      totalTransferMinutes: 0,
      activityCount: 0,
      museumCount: 0,
    },
    preferences: DEFAULT_TRIP_PREFERENCES,
    requirements: [],
    ...overrides,
  });
}

function event(id: string, refId: string, startMinute: number, locked = false) {
  return {
    id,
    refId,
    startMinute,
    kind: "activity" as const,
    title: refId,
    tags: [],
    durationMinutes: 60,
    location: null,
    locked,
  };
}

function review(
  code: ReviewerOutput["issues"][number]["code"],
  eventIds: string[] = [],
  suggestedOrder: string[] = [],
): ReviewerOutput {
  return {
    verdict: "revise",
    issues: [{ code, eventIds, explanation: "Consider improving the draft." }],
    suggestedOrder,
    explanation: "Qualitative review.",
  };
}

const options = { atBound: false, previousRevisionFingerprint: null };

describe("itinerary review policy", () => {
  it.each(["interest_mismatch", "insufficient_variety", "unexplained_compromise"] as const)(
    "shows %s as advice instead of adding unrequested visits",
    (code) => {
      const result = evaluateItineraryReview(context(), review(code), options);
      expect(result.verdict).toBe("acceptable");
      expect(result.suppressionReason).toBe("advisory");
      expect(result.warningIssues.map((issue) => issue.code)).toEqual([code]);
    },
  );

  it("does not replan a sparse day or move locked reservations and airport windows", () => {
    const draft = context({
      events: [event("a", "museum", 540, true), event("b", "park", 660, true)],
    });
    expect(
      evaluateItineraryReview(draft, review("poor_sequence", ["a", "b"], ["b", "a"]), options),
    ).toMatchObject({ verdict: "acceptable", suppressionReason: "advisory" });
    expect(evaluateItineraryReview(context(), review("pace_mismatch"), options).verdict).toBe(
      "acceptable",
    );
  });

  it("requires a different movable-stop order for a sequencing revision", () => {
    const draft = context({ events: [event("a", "museum", 540), event("b", "park", 660)] });
    expect(
      evaluateItineraryReview(draft, review("poor_sequence", ["a"], ["a", "b"]), options).verdict,
    ).toBe("acceptable");
    expect(
      evaluateItineraryReview(draft, review("poor_sequence", ["a"], ["a", "a"]), options).verdict,
    ).toBe("acceptable");
    expect(
      evaluateItineraryReview(draft, review("poor_sequence", ["a"], ["b", "a"]), options).verdict,
    ).toBe("revise");
  });

  it("stops the same revision on the same structure despite new event IDs or wording", () => {
    const first = context({ events: [event("a", "museum", 540), event("b", "park", 660)] });
    const previous = evaluateItineraryReview(first, review("excess_travel", ["a", "b"]), options);
    expect(previous.verdict).toBe("revise");
    const next = context({ events: [event("c", "museum", 540), event("d", "park", 660)] });
    const output = review("excess_travel", ["c", "d"]);
    output.issues[0]!.explanation = "The model phrased the same concern differently.";
    const result = evaluateItineraryReview(next, output, {
      ...options,
      previousRevisionFingerprint: previous.revisionFingerprint,
    });
    expect(result).toMatchObject({ verdict: "acceptable", suppressionReason: "no_progress" });
    expect(result.warningIssues).toEqual(output.issues);
    const changed = context({ events: [event("c", "museum", 570), event("d", "park", 690)] });
    expect(
      evaluateItineraryReview(changed, output, {
        ...options,
        previousRevisionFingerprint: previous.revisionFingerprint,
      }).verdict,
    ).toBe("revise");
  });

  it("keeps blocking conflicts blocking even at the attempt bound", () => {
    const output = { ...review("unexplained_compromise"), verdict: "conflict" as const };
    expect(evaluateItineraryReview(context(), output, { ...options, atBound: true })).toMatchObject(
      { verdict: "conflict", warningIssues: [], suppressionReason: null },
    );
  });

  it("retains advice from an acceptable review and demotes bounded structural revisions", () => {
    const draft = context({ events: [event("a", "museum", 540), event("b", "park", 660)] });
    const output = review("excess_travel", ["a", "b"]);
    expect(
      evaluateItineraryReview(draft, { ...output, verdict: "acceptable" }, options).warningIssues,
    ).toEqual(output.issues);
    expect(evaluateItineraryReview(draft, output, { ...options, atBound: true })).toMatchObject({
      verdict: "acceptable",
      warningIssues: output.issues,
      suppressionReason: "attempt_bound",
    });
  });
});
