import { InvalidUpdateError } from "@langchain/langgraph";
import { fingerprint } from "@odft/domain";
import { domainCommandSchema, type DomainCommand } from "@odft/contracts";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";
import { resolveCommandRouting, routingRefs } from "../routing/invalidation-matrix.js";
import { routeByNextWork, routeForCommandType } from "../routing/next-work-target.js";
import { stageRouteChangeIfImpactful } from "./stage-route-change.js";

/**
 * Phase 08 intent pipeline (07-conversation-and-intents.md sections 1-5).
 *
 * `interpret_intent` runs the configured intent role, then feeds the validated
 * result into the SAME deterministic command dispatcher the graphical controls
 * use. The whole batch is applied atomically: a command that cannot be honored
 * leaves none of the batch applied, and no command executes before a clarification
 * is answered. Assistant wording is persisted by the driver only AFTER the
 * operation result is committed. No model output can confirm, cancel, or book.
 */

/** Commands whose execution continues in a dedicated graph stage. */
const ROUTING_COMMANDS = ["set_program", "propose_selection"] as const;

function isRoutingCommand(command: DomainCommand): boolean {
  return (ROUTING_COMMANDS as readonly string[]).includes(command.type);
}

/**
 * Deterministic application order: the commands that can be refused (route change
 * after a confirmed reservation, program selection) run first, so a refusal never
 * leaves earlier preference writes behind. The batch itself is one transaction.
 */
export function orderCommandsForApplication(
  commands: readonly DomainCommand[],
): DomainCommand[] {
  const rank = (command: DomainCommand): number => {
    if (command.type === "set_route") return 0;
    if (command.type === "set_program") return 1;
    if (command.type === "propose_selection") return 2;
    if (command.type === "set_simulation") return 3;
    return 4;
  };
  return [...commands]
    .map((command, index) => ({ command, index }))
    .sort((a, b) => rank(a.command) - rank(b.command) || a.index - b.index)
    .map((entry) => entry.command);
}

function routingFor(commands: readonly DomainCommand[]): {
  commandType: string;
  commandPayload: unknown;
  submittedMealSelections?: TravelUpdate["submittedMealSelections"];
  submittedSelfArrangedMeals?: TravelUpdate["submittedSelfArrangedMeals"];
  submittedActivitiesSelfArranged?: boolean;
  submittedActivityIds?: string[];
} {
  // A route change outranks every other command in a batch: Stage A and Stage B
  // must re-run before any downstream step (a committed route change also drops
  // the stale selections the other commands would touch).
  const route = commands.find((command) => command.type === "set_route");
  if (route) {
    return { commandType: "route_change", commandPayload: route };
  }
  const program = commands.find((command) => command.type === "set_program");
  if (program && program.type === "set_program") {
    return {
      commandType: "set_program",
      commandPayload: program,
      submittedMealSelections: program.mealOfferIds,
      submittedSelfArrangedMeals: program.selfArrangedMeals,
      submittedActivitiesSelfArranged: program.activitiesSelfArranged,
      submittedActivityIds: program.preferredActivityIds,
    };
  }
  const proposal = commands.find((command) => command.type === "propose_selection");
  if (proposal) {
    return { commandType: "propose_selection", commandPayload: proposal };
  }
  // An explicit `build_itinerary` option (Phase 10 conflict clarifications)
  // replans directly instead of re-opening the program step.
  const build = commands.find((command) => command.type === "build_itinerary");
  if (build) {
    return { commandType: "build_itinerary", commandPayload: build };
  }
  return { commandType: "chat_applied", commandPayload: null };
}

async function applyCommands(
  state: TravelState,
  runtime: unknown,
  commands: readonly DomainCommand[],
  effectNode: string,
): Promise<{ routing: ReturnType<typeof routingFor>; appliedCount: number }> {
  const ports = travelPorts(runtime);
  const ordered = orderCommandsForApplication(commands);
  const result = await ports.runEffect(effectNode, `batch:${ordered.length}`, () =>
    ports.applyCommands({
      tripId: state.tripId,
      operationId: state.operationId,
      commands: ordered,
    }),
  );
  return { routing: routingFor(commands), appliedCount: result.appliedCount };
}

/**
 * Phase 11: apply an admitted batch through the deterministic dispatcher and
 * resolve the next work item from the invalidation matrix. A route change that
 * would invalidate confirmed reservations is staged as a confirmation instead of
 * being applied; everything else applies atomically as before.
 */
async function applyBatchAndRoute(
  state: TravelState,
  runtime: unknown,
  commands: readonly DomainCommand[],
  effectNode: string,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const staging = await stageRouteChangeIfImpactful({
    ports,
    nodeName: effectNode,
    tripId: state.tripId,
    operationId: state.operationId,
    commands,
  });
  if (staging.kind === "staged") {
    return staging.update;
  }
  const routeNoop = staging.kind === "noop";
  const { routing } = await applyCommands(state, runtime, commands, effectNode);
  const tripContext = await ports.loadTrip(state.tripId);
  if (!tripContext) {
    return routing;
  }
  const progress = await ports.loadProgress(state.tripId);
  const matrix = resolveCommandRouting({
    commands,
    refs: routingRefs({
      preferences: tripContext.trip.preferences,
      confirmedServices: progress.confirmedServices,
      selectedServices: progress.selectedServices,
      hasConfirmedFlight: progress.flightConfirmed,
      programApplied: progress.programApplied,
    }),
  });
  const search = commands.find((command) => command.type === "find_alternatives");
  // An APPLIED route change (the staging helper returned null) must re-run the
  // feasibility stages and start a fresh flight choice.
  // A noop `set_route` must not hijack the batch: another actionable command
  // (program/proposal/itinerary) keeps its own routing.
  const fallbackRouting = routeNoop
    ? routingFor(commands.filter((command) => command.type !== "set_route"))
    : null;
  const appliedRouteChange = matrix.resolution.routeChange && !routeNoop;
  // A search/decision that targets a downstream domain cannot run before the
  // flight step (no snapshot): present the prerequisite flight choice instead. A
  // flight declined through "I don't want to book" is kept as a selection, so it
  // counts as progressed.
  const targetedBeforeFlight =
    !progress.flightConfirmed &&
    !progress.selectedServices.includes("flights") &&
    (matrix.resolution.nextDecisionKind === "hotel_choice" ||
      matrix.resolution.nextDecisionKind === "program_choices");
  return {
    ...routing,
    ...(fallbackRouting ?? {}),
    nextWork: targetedBeforeFlight
      ? "route"
      : routeNoop
        ? "progress"
        : appliedRouteChange
          ? "route"
          : matrix.nextWork,
    nextDecisionKind: targetedBeforeFlight
      ? "flight_choice"
      : routeNoop
        ? state.nextDecisionKind
        : appliedRouteChange
          ? "flight_choice"
          : (matrix.resolution.nextDecisionKind ?? state.nextDecisionKind),
    hasConfirmedFlight: progress.flightConfirmed,
    hasConfirmedHotel: progress.hotelConfirmed,
    confirmedServices: [...progress.confirmedServices],
    selectedServices: [...progress.selectedServices],
    searchTargetDomains:
      search && !targetedBeforeFlight ? matrix.resolution.affectedDomains.slice(0, 1) : [],
    searchIntent:
      search && !targetedBeforeFlight && search.type === "find_alternatives"
        ? {
            target: search.target,
            objective: search.objective,
            level: search.level ?? null,
          }
        : null,
  };
}

export async function interpretIntentNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  if (!state.chatMessage) {
    return {};
  }
  const ports = travelPorts(runtime);
  const { result } = await ports.interpretIntent({
    tripId: state.tripId,
    operationId: state.operationId,
    message: state.chatMessage,
  });

  if (result.kind === "unsupported") {
    const interrupted = state.interruptedDecision;
    return {
      intentStatus: "unsupported",
      intentInterpretation: result.explanation,
      gate: "chat_done",
      pendingStage: "end",
      // A modification must not strand the trip: when this operation interrupted
      // a pending decision and nothing could be applied, re-present that exact
      // decision (its descriptor is still in the operation-local state) so the
      // step stays answerable instead of ending without a decision.
      ...(interrupted
        ? {
            restoredDecision: {
              decisionKind: interrupted.decisionKind,
              proposalId: state.proposalId,
              allowedOfferIds: state.allowedOfferIds,
              allowedOptionIds: state.allowedOptionIds,
              gate: interrupted.gate,
              pendingReplacement: state.pendingReplacement,
            },
          }
        : {}),
    };
  }

  if (result.kind === "clarification") {
    return {
      intentStatus: "clarification",
      clarificationQuestion: result.question,
      clarificationOptions: result.options,
      clarificationRequestedCommands: result.requestedCommands,
      intentPreserve: result.preserve,
      nextDecisionKind: "clarification",
      decisionFingerprint: fingerprint({
        kind: "clarification",
        tripId: state.tripId,
        operationId: state.operationId,
        question: result.question,
        options: result.options.map((option) => option.id),
      }),
      gate: "clarification",
      pendingStage: null,
    };
  }

  // More than one command that continues in its own stage cannot all run in one
  // pass: ask which one to do first instead of silently dropping the others.
  const routingCommands = result.commands.filter(isRoutingCommand);
  if (routingCommands.length > 1) {
    const others = result.commands.filter((command) => !isRoutingCommand(command));
    const options = routingCommands.slice(0, 4).map((command, index) => ({
      id: `opt_${index + 1}`,
      label:
        command.type === "set_program"
          ? "Apply the selected meals and activities first"
          : `Start the ${command.type === "propose_selection" ? command.service : "service"} selection first`,
      commands: [...others, command],
    }));
    if (options.length >= 2) {
      return {
        intentStatus: "clarification",
        clarificationQuestion: "This request contains several steps. Which one should I start with?",
        clarificationOptions: options,
        clarificationRequestedCommands: result.commands,
        intentPreserve: result.preserve,
        nextDecisionKind: "clarification",
        decisionFingerprint: fingerprint({
          kind: "clarification",
          tripId: state.tripId,
          operationId: state.operationId,
          question: "multiple_steps",
          options: options.map((option) => option.id),
        }),
        gate: "clarification",
        pendingStage: null,
      };
    }
  }

  const routed = await applyBatchAndRoute(
    state,
    runtime,
    result.commands,
    "interpret_intent",
  );
  return {
    ...routed,
    intentStatus: "commands",
    intentInterpretation: result.interpretation,
    intentPreserve: result.preserve,
  };
}

/** Apply the command list bound to the chosen clarification option. */
export async function resolveClarificationNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const option = state.clarificationOptions.find((candidate) => candidate.id === state.lastOptionId);
  if (!option) {
    throw new InvalidUpdateError("the chosen clarification option is no longer offered");
  }
  const routed = await applyBatchAndRoute(
    state,
    runtime,
    option.commands,
    "resolve_clarification",
  );
  return {
    ...routed,
    intentStatus: "commands",
    intentInterpretation: option.label,
    clarificationQuestion: null,
    clarificationOptions: [],
    clarificationRequestedCommands: [],
  };
}

/**
 * Handle the follow-up admitted while a decision was pending (Phase 11).
 *
 * A chat message is forwarded to the intent role (the message text is loaded
 * from the admitted operation). A typed command is applied directly through the
 * same deterministic dispatcher and matrix routing — it is a modification, so it
 * never needs an LLM call.
 */
export async function interpretModificationNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  if (!state.modificationOperationId) {
    throw new InvalidUpdateError("a modification requires an admitted command operation");
  }
  const ports = travelPorts(runtime);
  const payload = await ports.loadOperationPayload(state.modificationOperationId);
  const command = domainCommandSchema.safeParse(payload);
  if (command.success) {
    const routed = await applyBatchAndRoute(
      state,
      runtime,
      [command.data],
      "interpret_modification",
    );
    return {
      ...routed,
      // Effects belong to the new admitted operation, not the old checkpoint id.
      operationId: state.modificationOperationId,
      chatMessage: null,
      intentStatus: "commands",
      intentInterpretation: "Applied the requested change.",
      clarificationQuestion: null,
      clarificationOptions: [],
      clarificationRequestedCommands: [],
    };
  }
  const message = await ports.loadChatMessage(state.modificationOperationId);
  if (!message) {
    throw new InvalidUpdateError("the modification operation carries no chat message");
  }
  return {
    chatMessage: message,
    // Effects belong to the new admitted operation, not the old checkpoint id.
    operationId: state.modificationOperationId,
    intentStatus: "pending",
    clarificationQuestion: null,
    clarificationOptions: [],
  };
}

/**
 * Router after a pending-decision modification: a typed command has already been
 * applied and continues through the invalidation-matrix work item; a chat
 * message is interpreted by the intent role.
 */
export function routeAfterModification(state: TravelState): string {
  if (state.intentStatus !== "commands") {
    return "interpret_intent";
  }
  // A typed command admitted as a modification keeps its dedicated stage
  // (program/proposal/itinerary) or its staged route-change confirmation; only
  // preference/search commands fall through to the matrix work item.
  return routeForCommandType(state) ?? routeByNextWork(state) ?? "detect_progress";
}
