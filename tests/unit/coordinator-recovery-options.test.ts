import { describe, expect, it } from "vitest";
import { recoveryReopenOption } from "@odft/workflow";

describe("recovery reopen options", () => {
  it("maps both generic itinerary fallback ids to their reopening step", () => {
    expect(recoveryReopenOption("change_hotel")).toEqual({
      label: "Adjust the hotel",
      reopen: "hotel_choice",
    });
    expect(recoveryReopenOption("change_meals")).toEqual({
      label: "Adjust the meals",
      reopen: "program_choices",
    });
  });

  it("never treats an unrelated or budget option as a recovery reopen", () => {
    expect(recoveryReopenOption("raise_budget")).toBeUndefined();
    expect(recoveryReopenOption("unknown")).toBeUndefined();
  });
});
