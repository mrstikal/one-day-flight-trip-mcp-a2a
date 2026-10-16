import type { ActivityTag } from "@odft/contracts";
import type { PlannerOutput, ProposedStop } from "./roles/planner.js";

/**
 * Visits are OPT-IN (2026-10-14): a plan may contain exactly the explicitly
 * pinned activity IDs plus the candidates needed to satisfy the requested tag
 * minimums — nothing else. The live model reliably adds opportunistic extras
 * despite the planner-v2 instruction (observed live: two unrequested museums on
 * a trip with no pins and no requirements), so the worker strips them
 * deterministically before normalization and assembly.
 *
 * Pinned stops always stay and count toward the minimums; a non-pinned activity
 * is kept only while a tag it carries still has an outstanding minimum, so the
 * result is the minimum plus the pins, never more.
 */
export function enforceOptInVisits(
  output: PlannerOutput,
  input: {
    readonly preferredActivityIds: readonly string[];
    readonly minimumActivityCounts: Readonly<Partial<Record<ActivityTag, number>>>;
    readonly candidates: readonly {
      readonly id: string;
      readonly tags: readonly ActivityTag[];
    }[];
  },
): PlannerOutput {
  const pinned = new Set(input.preferredActivityIds);
  const tagsById = new Map(input.candidates.map((candidate) => [candidate.id, candidate.tags]));
  const activityStops = output.stops.filter(
    (stop): stop is Extract<ProposedStop, { kind: "activity" }> => stop.kind === "activity",
  );
  if (activityStops.length === 0) {
    return output;
  }
  // Outstanding minimums after the pinned stops have been counted.
  const outstanding = new Map<ActivityTag, number>();
  for (const [tag, minimum] of Object.entries(input.minimumActivityCounts) as [
    ActivityTag,
    number | undefined,
  ][]) {
    if ((minimum ?? 0) > 0) {
      outstanding.set(tag, minimum as number);
    }
  }
  for (const stop of activityStops) {
    if (!pinned.has(stop.refId)) {
      continue;
    }
    for (const tag of tagsById.get(stop.refId) ?? []) {
      const remaining = outstanding.get(tag);
      if (remaining !== undefined && remaining > 0) {
        outstanding.set(tag, remaining - 1);
      }
    }
  }

  let dropped = 0;
  const stops: ProposedStop[] = [];
  for (const stop of output.stops) {
    if (stop.kind !== "activity") {
      stops.push(stop);
      continue;
    }
    if (pinned.has(stop.refId)) {
      stops.push(stop);
      continue;
    }
    const needed = (tagsById.get(stop.refId) ?? []).some(
      (tag) => (outstanding.get(tag) ?? 0) > 0,
    );
    if (!needed) {
      dropped += 1;
      continue;
    }
    for (const tag of tagsById.get(stop.refId) ?? []) {
      const remaining = outstanding.get(tag);
      if (remaining !== undefined && remaining > 0) {
        outstanding.set(tag, remaining - 1);
      }
    }
    stops.push(stop);
  }
  if (dropped === 0) {
    return output;
  }
  return {
    ...output,
    stops,
    compromises: [
      ...output.compromises,
      `${dropped} unrequested visit${dropped === 1 ? "" : "s"} ${dropped === 1 ? "was" : "were"} removed: visits are planned only when you pin them or ask for them.`,
    ].slice(-10),
  };
}