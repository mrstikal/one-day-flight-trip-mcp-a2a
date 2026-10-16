import { chatCommandPayloadSchema, domainCommandSchema } from "@odft/contracts";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";
import { resolveCommandRouting, routingRefs } from "../routing/invalidation-matrix.js";
import { stageRouteChangeIfImpactful } from "./stage-route-change.js";

/**
 * Apply the admitted command to the trip's route/preferences. A creation run
 * already persisted its route inputs, so it has nothing to apply here. The
 * effect ledger makes a crash-replay re-apply nothing (idempotent values).
 *
 * A chat request carries no direct command: it is forwarded to `interpret_intent`,
 * which runs the intent role and then feeds the same deterministic dispatcher.
 *
 * Phase 11: a `set_route` that would invalidate confirmed reservations does not
 * apply here. It is staged as a `route_change_confirmation` decision carrying the
 * server-built impact preview (the affected reservation ids and the deferred
 * command batch); nothing is cancelled until the user confirms.
 */
export async function applyCommandsNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  if (state.operationKind === "start") {
    return {};
  }
  const parsed = domainCommandSchema.safeParse(state.commandPayload);
  if (!parsed.success) {
    const chat = chatCommandPayloadSchema.safeParse(state.commandPayload);
    if (chat.success) {
      return { chatMessage: chat.data.message };
    }
    // Non-domain payloads (e.g. an unexpected shape) cannot mutate the trip.
    return {};
  }
  const ports = travelPorts(runtime);
  const command = parsed.data;

  // Phase 11: a route change that would invalidate confirmed reservations opens
  // the impact-confirmation decision instead of applying.
  const staging = await stageRouteChangeIfImpactful({
    ports,
    nodeName: "apply_commands",
    tripId: state.tripId,
    operationId: state.operationId,
    commands: [command],
  });
  if (staging.kind === "staged") {
    return staging.update;
  }
  const routeNoop = staging.kind === "noop";

  await ports.runEffect("apply_commands", command.type, () =>
    ports.applyCommands({
      tripId: state.tripId,
      operationId: state.operationId,
      commands: [command],
    }),
  );
  if (command.type === "set_program") {
    // Carry the admitted program payload into apply_program (a command is a
    // request, so it applies deterministically just like submit_program).
    return {
      submittedMealSelections: command.mealOfferIds,
      submittedSelfArrangedMeals: command.selfArrangedMeals,
      submittedActivitiesSelfArranged: command.activitiesSelfArranged,
      submittedActivityIds: command.preferredActivityIds,
    };
  }

  // Phase 11: resolve the next work item from the invalidation matrix, using the
  // trip's persisted preferences and confirmed/selected services as the refs.
  const tripContext = await ports.loadTrip(state.tripId);
  if (!tripContext) {
    return {};
  }
  const progress = await ports.loadProgress(state.tripId);
  const routing = resolveCommandRouting({
    commands: [command],
    refs: routingRefs({
      preferences: tripContext.trip.preferences,
      confirmedServices: progress.confirmedServices,
      selectedServices: progress.selectedServices,
      hasConfirmedFlight: progress.flightConfirmed,
      programApplied: progress.programApplied,
    }),
  });
  // An APPLIED route change (no staged preview: no confirmed reservations, or a
  // same-value command) always re-runs the feasibility stages and starts a fresh
  // flight choice — never an empty confirmation.
  const appliedRouteChange = routing.resolution.routeChange && !routeNoop;
  // A search/decision that targets a downstream domain cannot run before the
  // flight step: no snapshot exists yet, so its offers would be empty. The
  // prerequisite flight choice is presented instead (Phase 11 review fix). A
  // flight declined through "I don't want to book" is kept as a selection, so it
  // counts as progressed.
  const targetedBeforeFlight =
    !progress.flightConfirmed &&
    !progress.selectedServices.includes("flights") &&
    (routing.resolution.nextDecisionKind === "hotel_choice" ||
      routing.resolution.nextDecisionKind === "program_choices");
  return {
    nextWork: targetedBeforeFlight
      ? "route"
      : routeNoop
        ? "progress"
        : appliedRouteChange
          ? "route"
          : routing.nextWork,
    nextDecisionKind: targetedBeforeFlight
      ? "flight_choice"
      : routeNoop
        ? state.nextDecisionKind
        : appliedRouteChange
          ? "flight_choice"
          : (routing.resolution.nextDecisionKind ?? state.nextDecisionKind),
    hasConfirmedFlight: progress.flightConfirmed,
    hasConfirmedHotel: progress.hotelConfirmed,
    confirmedServices: [...progress.confirmedServices],
    selectedServices: [...progress.selectedServices],
    searchTargetDomains:
      !targetedBeforeFlight && command.type === "find_alternatives"
        ? routing.resolution.affectedDomains.slice(0, 1)
        : [],
    searchIntent:
      !targetedBeforeFlight && command.type === "find_alternatives"
        ? {
            target: command.target,
            objective: command.objective,
            level: command.level ?? null,
          }
        : null,
  };
}
