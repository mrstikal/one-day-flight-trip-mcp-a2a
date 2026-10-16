import type { EventRef, SnapshotContext } from "@odft/contracts";
import { safeAnchor, type LandmarkAnchor } from "./anchors.js";
import { deriveEntityId } from "./ids.js";
import { createDomainFaker } from "./seed.js";

/**
 * Deterministic demo-event generator (05 sections 7-9). Events are explicitly
 * synthetic entertainment options; never a claim about a real venue program.
 */

export interface EventGenInput {
  readonly scenarioKey: string;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly context: SnapshotContext;
  readonly landmarks?: readonly LandmarkAnchor[];
}

const KINDS: readonly EventRef["kind"][] = ["performance", "exhibition", "festival"];
const NAMES = ["Demo Evening Performance", "Demo Local Exhibition", "Demo City Festival"];

export function generateEvents(input: EventGenInput): EventRef[] {
  const { context } = input;
  const faker = createDomainFaker(input.seed, input.scenarioKey, "events", input.generatorVersion);
  return KINDS.map((kind, index) => {
    const fraction = faker.number.float({ min: 0, max: 1 });
    const anchor = safeAnchor(faker, context, input.landmarks ?? [], index);
    const hour = 19 + index;
    return {
      id: deriveEntityId(input.scenarioKey, "events", index, kind),
      name: NAMES[index] ?? `Demo Event ${index}`,
      kind,
      date: context.sightseeingDate,
      startLocalTime: `${String(hour).padStart(2, "0")}:00 (simulated)`,
      durationMinutes: 90 + index * 15,
      ticketMinorPerAdult: 1200 + Math.round(fraction * 2300),
      anchor: {
        lat: anchor.lat,
        lon: anchor.lon,
        precisionMeters: 1000,
      },
      synthetic: true,
      demoLabels: ["Demo offer", "Simulated schedule/price", "Approximate location"],
    };
  });
}
