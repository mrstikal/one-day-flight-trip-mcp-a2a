import type { ReviewerContext, ReviewerOutput } from "@odft/ai";
import { fingerprint } from "@odft/domain";

/** Decide whether qualitative feedback can improve this already-valid draft. */
export function evaluateItineraryReview(
  context: ReviewerContext,
  output: ReviewerOutput,
  options: { atBound: boolean; previousRevisionFingerprint: string | null },
): {
  verdict: ReviewerOutput["verdict"];
  revisionFingerprint: string;
  warningIssues: ReviewerOutput["issues"];
  suppressionReason: "advisory" | "no_progress" | "attempt_bound" | null;
} {
  const eventsById = new Map(context.events.map((event) => [event.id, event]));
  const movable = context.events.filter(
    (event) => !event.locked && (event.kind === "meal" || event.kind === "activity"),
  );
  const movableIds = new Set(movable.map((event) => event.id));
  const suggested = [...new Set(output.suggestedOrder.filter((id) => movableIds.has(id)))];
  const suggestedIds = new Set(suggested);
  const currentOrder = movable
    .filter((event) => suggestedIds.has(event.id))
    .map((event) => event.id);
  const changesOrder =
    suggested.length >= 2 && suggested.some((id, index) => id !== currentOrder[index]);
  const actionable = output.issues.filter((issue) => {
    const touchesMovableStop =
      issue.eventIds.length === 0
        ? movable.length > 0
        : issue.eventIds.some((id) => movableIds.has(id));
    if (!touchesMovableStop) {
      return false;
    }
    switch (issue.code) {
      case "poor_sequence":
        return changesOrder;
      case "excess_travel":
        return movable.length >= 2;
      case "pace_mismatch":
        return context.metrics.activityCount > 0;
      default:
        return false;
    }
  });
  const eventKey = (id: string): string | null => {
    const event = eventsById.get(id);
    return event
      ? `${event.kind}:${event.refId ?? ""}:${event.startMinute}:${event.durationMinutes}`
      : null;
  };
  // Event UUIDs change between drafts; only resolved structure and findings count.
  const revisionFingerprint = fingerprint({
    events: context.events.map((event) => eventKey(event.id)),
    issues: actionable
      .map((issue) => ({ code: issue.code, events: issue.eventIds.map(eventKey).sort() }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    suggestedOrder: suggested.map(eventKey),
  });
  const suppressionReason =
    output.verdict !== "revise"
      ? null
      : actionable.length === 0
        ? "advisory"
        : options.atBound
          ? "attempt_bound"
          : revisionFingerprint === options.previousRevisionFingerprint
            ? "no_progress"
            : null;
  return {
    verdict: suppressionReason ? "acceptable" : output.verdict,
    revisionFingerprint,
    warningIssues:
      output.verdict === "conflict"
        ? []
        : output.issues.filter(
            (issue) =>
              output.verdict === "acceptable" ||
              suppressionReason !== null ||
              !actionable.includes(issue),
          ),
    suppressionReason,
  };
}
