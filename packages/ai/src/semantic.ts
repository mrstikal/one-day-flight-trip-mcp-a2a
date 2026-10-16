import {
  intentResultSchema,
  type ActivityTag,
  type ClarificationOption,
  type DomainCommand,
  type IntentResult,
  type ModelFacingIntentResult,
  type PreservableKey,
} from "@odft/contracts";

/**
 * Deterministic semantic validation of model intent output
 * (04-domain-model.md section 6 / 10-security section 6).
 *
 * A model result is a proposal: membership, duplicate/conflicting writes,
 * `preserve` conflicts, and the sightseeing-date window are checked here before
 * any command executes. A conflict converts the whole request into the
 * clarification form before partial execution; inside a clarification option a
 * conflicting variant is dropped (the option list must stay executable).
 */

export interface AuthorizedIntentContext {
  readonly knownCityIds: readonly string[];
  readonly knownAirportIds: readonly string[];
  readonly knownOfferIds: readonly string[];
  /** Activity ids that exist in the trip's active snapshot. */
  readonly knownActivityIds: readonly string[];
  /** Restaurant offer ids that exist in the trip's active snapshot. */
  readonly knownRestaurantIds: readonly string[];
  /** Server clock date, so a model cannot set a past/too-distant sightseeing date. */
  readonly todayIsoDate: string;
  readonly currentActivityCounts: Partial<Record<ActivityTag, number>>;
}

/** Re-parse model output into the canonical persisted union (structural subset). */
export function toCanonicalIntentResult(result: ModelFacingIntentResult): IntentResult {
  return intentResultSchema.parse(result);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(isoDate: string, days: number): string {
  const parsed = Date.parse(`${isoDate}T00:00:00.000Z`);
  return new Date(parsed + days * DAY_MS).toISOString().slice(0, 10);
}

/** Mirrors the BFF sightseeing-date window (today +2 .. today +365). */
export function isWithinSightseeingWindow(sightseeingDate: string, todayIsoDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sightseeingDate)) {
    return false;
  }
  return (
    sightseeingDate >= addDays(todayIsoDate, 2) && sightseeingDate <= addDays(todayIsoDate, 365)
  );
}

function writesKeys(command: DomainCommand): PreservableKey[] {
  switch (command.type) {
    case "set_route":
      return ["flights"];
    case "set_default_service_level":
      return ["hotel", "breakfast", "lunch", "dinner"];
    case "set_service_override":
      return [command.service];
    case "propose_selection":
      return [command.service];
    case "set_program":
      // A program stages meal selections/replacements for the meals it carries.
      return (["breakfast", "lunch", "dinner"] as const).filter(
        (meal) => command.mealOfferIds[meal] !== undefined,
      );
    default:
      return [];
  }
}

function fieldKey(command: DomainCommand): string {
  switch (command.type) {
    case "set_route":
      return "set_route";
    case "set_default_service_level":
      return "set_default_service_level";
    case "set_service_override":
      return `set_service_override:${command.service}`;
    case "set_activity_pace":
      return "set_activity_pace";
    case "set_interests":
      return "set_interests";
    case "set_activity_requirement":
      return `set_activity_requirement:${command.tag}`;
    case "set_budget":
      return "set_budget";
    case "find_alternatives":
      return `find_alternatives:${command.target}`;
    case "propose_selection":
      return `propose_selection:${command.service}`;
    case "set_program":
      return "set_program";
    default:
      return command.type;
  }
}

function membershipIssue(
  command: DomainCommand,
  context: AuthorizedIntentContext,
): string | undefined {
  if (command.type === "set_route") {
    if (command.originAirportId && !context.knownAirportIds.includes(command.originAirportId)) {
      return `origin airport ${command.originAirportId} is not an admitted reference`;
    }
    if (command.destinationCityId && !context.knownCityIds.includes(command.destinationCityId)) {
      return `destination city ${command.destinationCityId} is not an admitted reference`;
    }
    if (
      command.sightseeingDate &&
      !isWithinSightseeingWindow(command.sightseeingDate, context.todayIsoDate)
    ) {
      return `sightseeing date ${command.sightseeingDate} is outside the allowed window`;
    }
  }
  if (command.type === "propose_selection" && !context.knownOfferIds.includes(command.offerId)) {
    return `offer ${command.offerId} is not an authorized offer for this trip`;
  }
  if (command.type === "set_program") {
    for (const meal of ["breakfast", "lunch", "dinner"] as const) {
      const offerId = command.mealOfferIds[meal];
      // `null` is the explicit "meal not included" choice, not a reference.
      if (offerId !== undefined && offerId !== null && !context.knownRestaurantIds.includes(offerId)) {
        return `meal offer ${offerId} is not an admitted restaurant for this trip`;
      }
    }
    for (const activityId of command.preferredActivityIds) {
      if (!context.knownActivityIds.includes(activityId)) {
        return `activity ${activityId} is not an admitted activity for this trip`;
      }
    }
  }
  return undefined;
}

type Conflict =
  | { readonly kind: "duplicate"; readonly group: readonly DomainCommand[] }
  | { readonly kind: "preserve"; readonly keys: readonly PreservableKey[]; readonly command: DomainCommand };

/** Duplicate writes to the same field, or a write to a `preserve`d service. */
function detectConflict(
  commands: readonly DomainCommand[],
  preserve: readonly PreservableKey[],
): Conflict | undefined {
  const byField = new Map<string, DomainCommand[]>();
  for (const command of commands) {
    const key = fieldKey(command);
    byField.set(key, [...(byField.get(key) ?? []), command]);
  }
  for (const group of byField.values()) {
    if (group.length > 1) {
      return { kind: "duplicate", group };
    }
  }
  for (const command of commands) {
    const offending = writesKeys(command).filter((key) => preserve.includes(key));
    if (offending.length > 0) {
      return { kind: "preserve", keys: offending, command };
    }
  }
  return undefined;
}

function conflictToClarification(
  commands: DomainCommand[],
  preserve: PreservableKey[],
  conflict: Conflict,
): IntentResult {
  if (conflict.kind === "duplicate") {
    const first = conflict.group[0];
    const last = conflict.group[conflict.group.length - 1];
    if (!first || !last) {
      return unsupported("The request could not be turned into supported choices.");
    }
    return intentResultSchema.parse({
      kind: "clarification",
      question: "The request sets the same preference twice. Which value should be kept?",
      requestedCommands: commands,
      preserve,
      options: [
        { id: "keep_first", label: "Keep the first value", commands: [first] },
        { id: "keep_last", label: "Keep the last value", commands: [last] },
      ],
    });
  }
  const kept = commands.filter((candidate) => candidate !== conflict.command);
  const alternatives: DomainCommand[] =
    conflict.command.type === "propose_selection" && conflict.command.service !== "flights"
      ? [
          ...kept,
          {
            type: "find_alternatives",
            target: conflict.command.service,
            objective: "match_preferences",
          },
        ]
      : kept;
  const searchable = alternatives !== kept;
  return intentResultSchema.parse({
    kind: "clarification",
    question: `This request changes ${conflict.keys.join(" and ")}, which you asked to keep. What should happen?`,
    requestedCommands: commands,
    preserve,
    options: [
      { id: "keep_preserved", label: `Keep ${conflict.keys.join(" and ")} unchanged`, commands: kept },
      {
        id: "apply_change",
        label: searchable ? "Review supported alternatives" : "Use the graphical controls instead",
        commands: alternatives,
      },
    ],
  });
}

function unsupported(explanation: string): IntentResult {
  return intentResultSchema.parse({ kind: "unsupported", explanation });
}

/**
 * Validate a model-facing result against the authorized trip context.
 *
 * Returns the accepted canonical result, or a deterministic clarification when a
 * conflict is found. No command is executed here.
 */
export function validateIntentSemantics(
  raw: ModelFacingIntentResult,
  context: AuthorizedIntentContext,
): IntentResult {
  const result = toCanonicalIntentResult(raw);
  if (result.kind === "unsupported") {
    return result;
  }
  if (result.kind === "clarification") {
    return validateClarification(result, context);
  }

  const commands = result.commands;
  if (commands.length === 0) {
    return unsupported("No supported change was recognized; use the graphical controls.");
  }

  // Membership: foreign or out-of-window references are rejected before execution.
  for (const command of commands) {
    const issue = membershipIssue(command, context);
    if (issue) {
      const kept = commands.filter((candidate) => candidate !== command);
      const alternatives: DomainCommand[] =
        command.type === "propose_selection" && command.service !== "flights"
          ? [
              ...kept,
              { type: "find_alternatives", target: command.service, objective: "match_preferences" },
            ]
          : kept;
      return intentResultSchema.parse({
        kind: "clarification",
        question: `${issue}. Keep the current choice, or review supported alternatives?`,
        requestedCommands: commands,
        preserve: result.preserve,
        options: [
          { id: "keep_current", label: "Keep the current choice", commands: kept },
          {
            id: "search_alternatives",
            label:
              alternatives !== kept
                ? "Review supported alternatives"
                : "Use the graphical controls instead",
            commands: alternatives,
          },
        ],
      });
    }
  }

  const conflict = detectConflict(commands, result.preserve);
  if (conflict) {
    return conflictToClarification(commands, result.preserve, conflict);
  }
  return result;
}

function validateClarification(
  result: Extract<IntentResult, { kind: "clarification" }>,
  context: AuthorizedIntentContext,
): IntentResult {
  const sanitized: ClarificationOption[] = [];
  for (const option of result.options) {
    const valid = option.commands.every(
      (command) => membershipIssue(command, context) === undefined,
    );
    // A variant with conflicting writes would apply "last value wins" silently, so
    // it is dropped here exactly like the direct commands branch would clarify it.
    const conflicting = detectConflict(option.commands, result.preserve) !== undefined;
    if (!valid || conflicting) {
      continue;
    }
    sanitized.push({
      // Opaque server-side ids; model-provided ids are never authoritative.
      id: `opt_${sanitized.length + 1}`,
      label: option.label,
      commands: option.commands,
    });
  }
  if (sanitized.length < 2 || sanitized.length > 4) {
    return unsupported(
      "The request could not be turned into two or more supported choices; use the graphical controls.",
    );
  }
  return intentResultSchema.parse({
    kind: "clarification",
    question: result.question,
    requestedCommands: result.requestedCommands,
    preserve: result.preserve,
    options: sanitized,
  });
}
