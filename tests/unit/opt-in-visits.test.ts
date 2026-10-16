import { describe, expect, it } from "vitest";
import { enforceOptInVisits } from "../../packages/ai/src/opt-in-visits.js";
import type { PlannerOutput } from "../../packages/ai/src/roles/planner.js";

/**
 * Visits are OPT-IN (2026-10-14): the live model reliably adds unrequested
 * activity stops despite the planner-v2 prompt, so the worker strips them
 * deterministically — only pinned IDs and candidates that satisfy a stored tag
 * minimum may remain in the plan.
 */

const candidates = [
  { id: "m-1", tags: ["museum"] as const },
  { id: "m-2", tags: ["museum"] as const },
  { id: "m-3", tags: ["museum"] as const },
  { id: "p-1", tags: ["park"] as const },
  { id: "c-1", tags: ["landmark", "architecture"] as const },
];

function output(stops: PlannerOutput["stops"]): PlannerOutput {
  return { stops, explanation: "drafted", compromises: [] };
}

const stop = (refId: string): PlannerOutput["stops"][number] => ({
  kind: "activity",
  refId,
  startMinute: 9 * 60,
  durationMinutes: 90,
});

describe("enforceOptInVisits", () => {
  it("drops every unrequested visit when nothing is pinned or required", () => {
    const enforced = enforceOptInVisits(
      output([
        { kind: "meal", refId: "m-b", startMinute: 8 * 60, durationMinutes: 45 },
        stop("m-1"),
        stop("c-1"),
        { kind: "meal", refId: "m-l", startMinute: 12 * 60, durationMinutes: 60 },
      ]),
      { preferredActivityIds: [], minimumActivityCounts: {}, candidates },
    );
    expect(enforced.stops.map((entry) => entry.kind)).toEqual(["meal", "meal"]);
    expect(enforced.compromises.join(" ")).toContain("2 unrequested visits were removed");
  });

  it("keeps pinned visits and exactly the minimum-filling candidates", () => {
    const enforced = enforceOptInVisits(
      output([stop("m-1"), stop("m-2"), stop("m-3"), stop("p-1"), stop("c-1")]),
      {
        preferredActivityIds: ["c-1"],
        minimumActivityCounts: { museum: 2 },
        candidates,
      },
    );
    // The pinned landmark plus two museums fill the minimum; the third museum
    // and the park are unrequested extras.
    expect(enforced.stops.map((entry) => ("refId" in entry ? entry.refId : null))).toEqual([
      "m-1",
      "m-2",
      "c-1",
    ]);
    expect(enforced.compromises.join(" ")).toContain("2 unrequested visits were removed");
  });

  it("is a no-op when the plan is already opt-in compliant", () => {
    const compliant = output([stop("m-1"), stop("c-1")]);
    const enforced = enforceOptInVisits(compliant, {
      preferredActivityIds: ["c-1"],
      minimumActivityCounts: { museum: 1 },
      candidates,
    });
    expect(enforced).toBe(compliant);
  });
});