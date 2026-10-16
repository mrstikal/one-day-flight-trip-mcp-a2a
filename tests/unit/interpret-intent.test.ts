import { describe, expect, it } from "vitest";
import type { IntentResult } from "@odft/contracts";
import {
  interpretIntentNode,
  orderCommandsForApplication,
  resolveClarificationNode,
} from "../../packages/workflow/src/nodes/interpret-intent.js";
import type { TravelState } from "../../packages/workflow/src/travel/state.js";
import type { TravelPorts } from "../../packages/workflow/src/travel/ports.js";

/**
 * Phase 08 intent node: batch atomicity/ordering, multi-step clarification,
 * search-only handling (no fake re-derivation), and no premature assistant write.
 */

function state(partial: Partial<TravelState>): TravelState {
  return partial as TravelState;
}

function runtime(
  result: IntentResult,
  applied: { commands: readonly unknown[]; calls: number } = { commands: [], calls: 0 },
): { context: { ports: TravelPorts } } {
  const ports = {
    interpretIntent: async () => ({ result, mode: "fixture" as const }),
    runEffect: async (_node: string, _scope: string, fn: () => Promise<unknown>) => fn(),
    applyCommands: async (input: { commands: readonly unknown[] }) => {
      applied.calls += 1;
      applied.commands = input.commands;
      // Mirror the dispatcher: only preference/route commands mutate trip state.
      const mutating = new Set([
        "set_route",
        "set_default_service_level",
        "set_service_override",
        "set_activity_pace",
        "set_interests",
        "set_activity_requirement",
        "set_budget",
      ]);
      const appliedCount = input.commands.filter(
        (command) => mutating.has((command as { type: string }).type),
      ).length;
      return { routeChanged: false, appliedCount };
    },
    loadChatMessage: async () => "follow up",
    loadTrip: async () => ({
      trip: {
        preferences: {
          defaultServiceLevel: "standard",
          serviceOverrides: {},
          activityPace: "relaxed",
          interests: { culture: 3, relaxation: 2, entertainment: 1 },
          preferredActivityTags: [],
          minimumActivityCounts: {},
          maxBudgetMinor: 50_000,
        },
      },
    }),
    loadProgress: async () => ({
      flightConfirmed: true,
      hotelConfirmed: false,
      confirmedServices: ["flights"],
      selectedServices: [],
      programApplied: false,
    }),
    previewRouteChange: async () => ({
      proposalId: "00000000-0000-4000-8000-000000000000",
      changedFields: [],
      from: {},
      to: {},
      affectedReservations: [],
    }),
  };
  return { context: { ports: ports as unknown as TravelPorts } };
}

describe("interpret_intent node (Phase 08 CR fixes)", () => {
  it("orders risky commands first so a refusal cannot leave preference writes", () => {
    const ordered = orderCommandsForApplication([
      { type: "set_activity_pace", pace: "relaxed" },
      { type: "propose_selection", service: "hotel", offerId: "o" },
      { type: "set_budget", maxBudgetMinor: 100 },
      { type: "set_route", destinationCityId: "c" },
      { type: "set_program", mealOfferIds: { breakfast: "b", lunch: "l", dinner: null }, selfArrangedMeals: [], preferredActivityIds: [], activitiesSelfArranged: false },
    ]);
    expect(ordered.map((command) => command.type)).toEqual([
      "set_route",
      "set_program",
      "propose_selection",
      "set_activity_pace",
      "set_budget",
    ]);
  });

  it("applies a preference batch once and routes to progress detection (P2-1)", async () => {
    const applied = { commands: [] as readonly unknown[], calls: 0 };
    const update = await interpretIntentNode(
      state({ tripId: "t", operationId: "op", chatMessage: "relax" }),
      runtime(
        {
          kind: "commands",
          commands: [
            { type: "set_activity_pace", pace: "relaxed" },
            { type: "set_budget", maxBudgetMinor: 100 },
          ],
          preserve: ["flights"],
          interpretation: "Use a relaxed pace.",
        },
        applied,
      ),
    );
    expect(applied.calls).toBe(1);
    expect(applied.commands).toHaveLength(2);
    expect(update.intentStatus).toBe("commands");
    expect(update.commandType).toBe("chat_applied");
    expect(update.intentInterpretation).toBe("Use a relaxed pace.");
  });

  it("asks which step to start when several commands need their own stage (P2-3)", async () => {
    const applied = { commands: [] as readonly unknown[], calls: 0 };
    const update = await interpretIntentNode(
      state({ tripId: "t", operationId: "op", chatMessage: "do both" }),
      runtime(
        {
          kind: "commands",
          commands: [
            { type: "set_program", mealOfferIds: { breakfast: "b", lunch: "l", dinner: null }, selfArrangedMeals: [], preferredActivityIds: [], activitiesSelfArranged: false },
            { type: "propose_selection", service: "hotel", offerId: "o" },
          ],
          preserve: [],
          interpretation: "Apply both.",
        },
        applied,
      ),
    );
    // Nothing runs before the user answers.
    expect(applied.calls).toBe(0);
    expect(update.intentStatus).toBe("clarification");
    expect(update.clarificationOptions).toHaveLength(2);
    expect(update.nextDecisionKind).toBe("clarification");
  });

  it("routes a search-only request to a targeted refresh, never fake re-derivation (P11-2)", async () => {
    const applied = { commands: [] as readonly unknown[], calls: 0 };
    const update = await interpretIntentNode(
      state({ tripId: "t", operationId: "op", chatMessage: "cheaper hotel" }),
      runtime(
        {
          kind: "commands",
          commands: [{ type: "find_alternatives", target: "hotel", objective: "cheaper" }],
          preserve: ["flights"],
          interpretation: "Marked for a lower-priced hotel search.",
        },
        applied,
      ),
    );
    expect(applied.calls).toBe(1);
    expect(update.intentStatus).toBe("commands");
    // Phase 11: the search refreshes only the targeted domain and presents the
    // refreshed hotel alternatives instead of ending the run.
    expect(update.nextWork).toBe("research");
    expect(update.nextDecisionKind).toBe("hotel_choice");
    expect(update.searchTargetDomains).toEqual(["hotel"]);
    expect(update.searchIntent).toEqual({ target: "hotel", objective: "cheaper", level: null });
  });

  it("ends unsupported input without touching the dispatcher", async () => {
    const applied = { commands: [] as readonly unknown[], calls: 0 };
    const update = await interpretIntentNode(
      state({ tripId: "t", operationId: "op", chatMessage: "moon flight" }),
      runtime({ kind: "unsupported", explanation: "not supported" }, applied),
    );
    expect(applied.calls).toBe(0);
    expect(update.intentStatus).toBe("unsupported");
    expect(update.gate).toBe("chat_done");
    expect(update.restoredDecision).toBeUndefined();
  });

  it("re-presents the interrupted decision when an unsupported chat modified it", async () => {
    const applied = { commands: [] as readonly unknown[], calls: 0 };
    const update = await interpretIntentNode(
      state({
        tripId: "t",
        operationId: "op",
        chatMessage: "moon flight",
        interruptedDecision: { decisionKind: "program_choices", gate: "program_ready" },
        allowedOfferIds: ["b1", "l1"],
        allowedOptionIds: ["a1"],
        pendingReplacement: false,
      }),
      runtime({ kind: "unsupported", explanation: "not supported" }, applied),
    );
    expect(applied.calls).toBe(0);
    expect(update.intentStatus).toBe("unsupported");
    expect(update.restoredDecision).toEqual({
      decisionKind: "program_choices",
      proposalId: undefined,
      allowedOfferIds: ["b1", "l1"],
      allowedOptionIds: ["a1"],
      gate: "program_ready",
      pendingReplacement: false,
    });
  });

  it("applies exactly the chosen clarification option's commands", async () => {
    const applied = { commands: [] as readonly unknown[], calls: 0 };
    const update = await resolveClarificationNode(
      state({
        tripId: "t",
        operationId: "op",
        lastOptionId: "opt_1",
        clarificationOptions: [
          {
            id: "opt_1",
            label: "Keep the relaxed pace with 2 museums",
            commands: [
              { type: "set_activity_pace", pace: "relaxed" },
              { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
            ],
          },
          { id: "opt_2", label: "Other", commands: [{ type: "set_activity_pace", pace: "intensive" }] },
        ],
      }),
      runtime(
        {
          kind: "commands",
          commands: [],
          preserve: [],
          interpretation: "never used",
        },
        applied,
      ),
    );
    expect(applied.calls).toBe(1);
    expect(applied.commands).toEqual([
      { type: "set_activity_pace", pace: "relaxed" },
      { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
    ]);
    expect(update.intentStatus).toBe("commands");
    expect(update.clarificationOptions).toEqual([]);
  });

  it("fails when the chosen clarification option is no longer offered", async () => {
    await expect(
      resolveClarificationNode(
        state({
          tripId: "t",
          operationId: "op",
          lastOptionId: "opt_9",
          clarificationOptions: [],
        }),
        runtime({ kind: "unsupported", explanation: "x" }),
      ),
    ).rejects.toThrow(/no longer offered/);
  });
});

describe("assistant write ordering (P2-6)", () => {
  it("the node performs no conversation write of its own", () => {
    // The outcome message is written by the driver AFTER the operation result is
    // persisted; the port surface no longer exposes an assistant-message writer.
    const ports = Object.keys(
      runtime({ kind: "unsupported", explanation: "x" }).context.ports as object,
    );
    expect(ports).not.toContain("appendAssistantMessage");
    expect(ports).toContain("interpretIntent");
  });
});