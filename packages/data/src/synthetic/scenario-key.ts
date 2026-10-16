import { createHash } from "node:crypto";
import type { GenerationInputs } from "@odft/contracts";
import { generationInputsSchema } from "@odft/contracts";

/**
 * Stable `scenarioKey` (05-synthetic-data-design.md section 7).
 *
 * Hashes seed, origin, destination/airport-pair context, date, variant, party
 * size, and reference/generator/rule versions. Excludes service preferences,
 * pace/interests, decisions/operation IDs, AI model IDs, and the current clock,
 * so those never regenerate inventory.
 */

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = sortKeys(entry);
      }
    }
    return sorted;
  }
  return value;
}

export function buildScenarioKey(inputs: GenerationInputs): string {
  const parsed = generationInputsSchema.parse(inputs);
  const payload = {
    seed: parsed.seed,
    originAirportId: parsed.originAirportId,
    originIata: parsed.originIata,
    destinationCityId: parsed.destinationCityId,
    destinationCountryKey: parsed.destinationCountryKey,
    destinationAirportIds: [...parsed.destinationAirportIds].sort(),
    sightseeingDate: parsed.sightseeingDate,
    travelVariant: parsed.travelVariant,
    adults: parsed.adults,
    generatorVersion: parsed.generatorVersion,
    referenceVersion: parsed.referenceVersion,
    routePolicyVersion: parsed.routePolicyVersion,
  };
  return createHash("sha256").update(canonical(payload), "utf8").digest("hex");
}
