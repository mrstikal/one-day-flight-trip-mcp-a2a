import { describe, expect, it } from "vitest";
import { activityVisitBudget } from "../../../packages/domain/src/itinerary/visit-budget.js";

/**
 * Live visit-time budget (08 section 7): the activities step warns and disables
 * Save while the selected visit minutes exceed the pace cap; the arithmetic is
 * authoritative server-side, never client-derived.
 */

const activities = [
  { id: "a", durationMinutes: 90 },
  { id: "b", durationMinutes: 120 },
  { id: "c", durationMinutes: 60 },
];

describe("activityVisitBudget", () => {
  it("reports usage under the relaxed cap and the pace target range", () => {
    const budget = activityVisitBudget({ pace: "relaxed", activities, selectedIds: ["a", "b"] });
    expect(budget.fits).toBe(true);
    expect(budget.selectedCount).toBe(2);
    expect(budget.selectedMinutes).toBe(210);
    expect(budget.capMinutes).toBe(240);
    expect(budget.overMinutes).toBe(0);
    expect(budget.targetMin).toBe(2);
    expect(budget.targetMax).toBe(3);
  });

  it("flags an over-cap selection with the exact overflow", () => {
    const budget = activityVisitBudget({
      pace: "relaxed",
      activities,
      selectedIds: ["a", "b", "c"],
    });
    expect(budget.fits).toBe(false);
    expect(budget.selectedMinutes).toBe(270);
    expect(budget.overMinutes).toBe(30);
    // The same selection fits the intensive cap (480).
    expect(
      activityVisitBudget({ pace: "intensive", activities, selectedIds: ["a", "b", "c"] }).fits,
    ).toBe(true);
  });

  it("keeps the cap per pace and treats exactly-at-cap as fitting", () => {
    const moderate = activityVisitBudget({
      pace: "moderate",
      activities,
      selectedIds: ["a", "b", "c"],
    });
    expect(moderate.capMinutes).toBe(360);
    expect(moderate.selectedMinutes).toBe(270);
    expect(moderate.fits).toBe(true);
    const atCap = activityVisitBudget({
      pace: "relaxed",
      activities: [{ id: "long", durationMinutes: 240 }],
      selectedIds: ["long"],
    });
    expect(atCap.selectedMinutes).toBe(240);
    expect(atCap.overMinutes).toBe(0);
    expect(atCap.fits).toBe(true);
    const empty = activityVisitBudget({ pace: "relaxed", activities, selectedIds: [] });
    expect(empty.fits).toBe(true);
    expect(empty.selectedCount).toBe(0);
  });

  it("ignores ids that are not in the snapshot inventory", () => {
    const budget = activityVisitBudget({
      pace: "relaxed",
      activities,
      selectedIds: ["a", "ghost", "b"],
    });
    expect(budget.selectedCount).toBe(2);
    expect(budget.selectedMinutes).toBe(210);
  });
});