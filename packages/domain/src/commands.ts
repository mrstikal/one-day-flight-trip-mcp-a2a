import type { DomainCommand, PreservableKey } from "@odft/contracts";
import { DomainError } from "./errors.js";

/**
 * Deterministic command semantic checks (04-domain-model.md section 6): reject
 * duplicate/conflicting writes to the same field, `preserve` conflicts, and a
 * `set_route` that changes nothing.
 */

const PRESERVABLE_SERVICES: readonly PreservableKey[] = [
  "flights",
  "hotel",
  "breakfast",
  "lunch",
  "dinner",
  "activities",
  "events",
];

interface CommandEffect {
  readonly fieldKeys: readonly string[];
  readonly preserveScope: readonly PreservableKey[];
}

function effectOf(command: DomainCommand): CommandEffect {
  switch (command.type) {
    case "set_route": {
      const fields: string[] = [];
      if (command.originAirportId !== undefined) fields.push("route.originAirportId");
      if (command.destinationCityId !== undefined) fields.push("route.destinationCityId");
      if (command.destinationCityId !== undefined) fields.push("route.destinationCountryKey");
      if (command.sightseeingDate !== undefined) fields.push("route.sightseeingDate");
      if (command.travelVariant !== undefined) fields.push("route.travelVariant");
      return { fieldKeys: fields, preserveScope: ["flights"] };
    }
    case "set_default_service_level":
      return { fieldKeys: ["defaultServiceLevel"], preserveScope: ["hotel", "breakfast", "lunch", "dinner"] };
    case "set_service_override":
      return { fieldKeys: [`serviceOverride.${command.service}`], preserveScope: [command.service] };
    case "set_activity_pace":
      return { fieldKeys: ["activityPace"], preserveScope: ["activities"] };
    case "set_interests":
      return { fieldKeys: ["interests", "preferredTags"], preserveScope: ["activities"] };
    case "set_activity_requirement":
      return { fieldKeys: [`minimumActivityCounts.${command.tag}`], preserveScope: ["activities"] };
    case "set_budget":
      return { fieldKeys: ["maxBudgetMinor"], preserveScope: [] };
    case "find_alternatives":
      return { fieldKeys: [], preserveScope: [] };
    case "propose_selection":
      return { fieldKeys: [`selection.${command.service}`], preserveScope: [command.service] };
    case "set_program":
      return { fieldKeys: ["program"], preserveScope: ["breakfast", "lunch", "dinner", "activities"] };
    case "build_itinerary":
      return { fieldKeys: ["itinerary"], preserveScope: [] };
    case "retry_failed_domains":
    case "set_simulation":
      return { fieldKeys: [], preserveScope: [] };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

/** `set_route` must change at least one field. */
export function assertSetRouteChangesField(command: DomainCommand): void {
  if (command.type !== "set_route") {
    return;
  }
  const changed =
    command.originAirportId !== undefined ||
    command.destinationCityId !== undefined ||
    command.sightseeingDate !== undefined ||
    command.travelVariant !== undefined;
  if (!changed) {
    throw new DomainError("VALIDATION_FAILED", "set_route must change at least one route field");
  }
}

/** Reject two commands writing the same field and commands that conflict with `preserve`. */
export function validateCommandBatch(
  commands: readonly DomainCommand[],
  preserve: readonly PreservableKey[] = [],
): void {
  if (commands.length > 4) {
    throw new DomainError("VALIDATION_FAILED", "at most four commands per intent");
  }
  const preserveSet = new Set(preserve);
  const seenFields = new Set<string>();

  for (const command of commands) {
    assertSetRouteChangesField(command);
    const effect = effectOf(command);
    for (const field of effect.fieldKeys) {
      if (seenFields.has(field)) {
        throw new DomainError("VALIDATION_FAILED", `conflicting writes to ${field}`);
      }
      seenFields.add(field);
    }
    for (const scope of effect.preserveScope) {
      if (preserveSet.has(scope)) {
        throw new DomainError("CONFLICT", `command conflicts with preserved scope ${scope}`);
      }
    }
  }
}

export function isPreservableKey(value: string): value is PreservableKey {
  return (PRESERVABLE_SERVICES as readonly string[]).includes(value);
}
