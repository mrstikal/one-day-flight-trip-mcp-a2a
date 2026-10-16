"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  activityFitResponseSchema,
  type ActivityFitResponse,
  type ActivityTag,
  type PublicDecisionResponse,
} from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { submitCommand, submitDecision } from "@/lib/decision-client";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { ActivityCard } from "@/components/program/ActivityCard";
import { InterestControls } from "@/components/program/InterestControls";
import { RecoveryCard } from "@/components/booking/RecoveryCard";
import { StepIndicator } from "@/components/trip/StepIndicator";
import { ErrorPanel, StatusPanel } from "@/components/wizard/FlightGating";
import { PlanningStoppedCard } from "@/components/wizard/PlanningStoppedCard";

const MEALS = ["breakfast", "lunch", "dinner"] as const;

/** Activities step: program choices focused on the sightseeing activity list. */
/** Human visit duration ("3 h 25 min"), never raw minutes (UX, 2026-10-14). */
function formatVisitMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest} min`;
  }
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function ActivitiesView({ tripId }: { readonly tripId: string }): React.JSX.Element {
  const { projection, error, refresh } = useTripProjection(tripId);
  const onEvent = useCallback(() => refresh(), [refresh]);
  const { reconnecting } = useTripEvents(tripId, onEvent);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [selectedOverride, setSelectedOverride] = useState<readonly string[] | null>(null);
  const [selfArrangedOverride, setSelfArrangedOverride] = useState<boolean | null>(null);
  const [budgetCheck, setBudgetCheck] = useState<{
    readonly key: string;
    readonly fit: ActivityFitResponse;
  } | null>(null);

  // Live visit-time budget (08 section 7): the server computes the selected visit
  // minutes against the pace cap, so the step can warn and disable Save while the
  // selection does not fit. Debounced; failures fall back to no warning (the
  // planner still owns full feasibility). The check is keyed by the selection it
  // was computed for, so a stale result never blocks or warns for a new one.
  const hasProgram = Boolean(projection?.program);
  const selectionKey = (
    selectedOverride ??
    projection?.program?.preferredActivityIds ??
    []
  ).join(",");
  const selfArrangedKey =
    selfArrangedOverride ?? projection?.program?.activitiesSelfArranged ?? false;
  const paceKey = projection?.trip.preferences.activityPace ?? null;
  useEffect(() => {
    if (!hasProgram || selfArrangedKey || paceKey === null) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/trips/${tripId}/activity-fit?ids=${encodeURIComponent(selectionKey)}`, {
        signal: controller.signal,
      })
        .then(async (response) =>
          response.ok ? activityFitResponseSchema.parse(await response.json()) : null,
        )
        .then((fit) => {
          if (fit) {
            setBudgetCheck({ key: selectionKey, fit });
          }
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [hasProgram, paceKey, selectionKey, selfArrangedKey, tripId]);
  // What the CURRENT plan already contains (planner picks plus pinned
  // selections): shown so the user does not re-pick a visit that is already in
  // the day, and to answer "is this budget line counting the planned museums?".
  const plannedVisits = (projection?.itinerary?.events ?? []).filter(
    (event) => event.kind === "activity",
  );
  const plannedById = new Map(
    plannedVisits
      .filter((event) => typeof event.refId === "string")
      .map((event) => [event.refId as string, `${event.startLocal}–${event.endLocal}`]),
  );
  const durationById = new Map(
    (projection?.program?.activities ?? []).map((activity) => [activity.id, activity.durationMinutes]),
  );
  const planMetrics = projection?.itinerary?.validation.metrics ?? null;
  const planTagBreakdown =
    planMetrics && Object.keys(planMetrics.activityTagCounts).length > 0
      ? ` (${Object.entries(planMetrics.activityTagCounts)
          .sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0))
          .map(([tag, count]) => `${count} ${tag}${count === 1 ? "" : "s"}`)
          .join(", ")})`
      : "";
  const planVisitSummary =
    planMetrics && planMetrics.activityCount > 0
      ? `${planMetrics.activityCount} visit${planMetrics.activityCount === 1 ? "" : "s"} · about ${formatVisitMinutes(planMetrics.visitMinutes)}${planTagBreakdown} — ${plannedVisits
          .map((event) => `${event.title} (${event.startLocal}–${event.endLocal})`)
          .join(", ")}`
      : null;

  const visitBudget =
    selfArrangedKey || budgetCheck?.key !== selectionKey ? null : budgetCheck.fit;
  const newSelectedIds = (selectedOverride ?? projection?.program?.preferredActivityIds ?? []).filter(
    (id) => !plannedById.has(id),
  );
  const newSelectionCount = newSelectedIds.length;
  const newSelectionMinutes = newSelectedIds.reduce(
    (sum, id) => sum + (durationById.get(id) ?? 0),
    0,
  );

  const submitResponse = useCallback(
    async (
      decisionId: string,
      revision: number,
      response: PublicDecisionResponse,
    ): Promise<boolean> => {
      setBusy(true);
      setActionError(undefined);
      try {
        await submitDecision({ tripId, decisionId, expectedRevision: revision, response });
        refresh();
        return true;
      } catch (caught) {
        setActionError(
          caught instanceof ApiError ? caught.message : "The request could not be completed.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, tripId],
  );

  const activeWork = useMemo(
    () =>
      projection?.operations.some(
        (operation) => operation.status === "queued" || operation.status === "running",
      ) ?? false,
    [projection],
  );

  if (!projection) {
    if (error) {
      return <ErrorPanel message={error.message} onRetry={refresh} />;
    }
    return <StatusPanel message="Loading your activities…" />;
  }

  const { program, pendingDecision } = projection;
  const selectedIds = selectedOverride ?? program?.preferredActivityIds ?? [];
  const activitiesSelfArranged = selfArrangedOverride ?? program?.activitiesSelfArranged ?? false;

  // Activity preferences are commands (set_program / pace) that the graph applies
  // through its `modify` branch even while a decision is pending (Phase 11), so
  // this step stays editable during the itinerary approval and an open
  // clarification — the same principle as the meals step's saved view. It stays
  // read-only while a decision that must be answered elsewhere is pending (meal
  // program choice, staged booking confirmations).
  const preferencesEditable =
    pendingDecision === null ||
    pendingDecision.kind === "itinerary_approval" ||
    pendingDecision.kind === "clarification";
  const requirementEntries = Object.entries(
    projection?.trip.preferences.minimumActivityCounts ?? {},
  ).filter(([, count]) => (count ?? 0) > 0) as [ActivityTag, number][];

  function toggleActivity(id: string): void {
    setSelectedOverride(
      selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id],
    );
  }

  async function saveActivities(): Promise<void> {
    if (!program || !projection) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: projection.trip.revision,
        command: {
          type: "set_program",
          mealOfferIds: {
            breakfast: program.selfArrangedMeals.breakfast
              ? null
              : (program.selectedMeals.breakfast ?? program.mealDefaults.breakfast),
            lunch: program.selfArrangedMeals.lunch
              ? null
              : (program.selectedMeals.lunch ?? program.mealDefaults.lunch),
            dinner:
              program.dinnerNotIncludedReason || program.selfArrangedMeals.dinner
                ? null
                : (program.selectedMeals.dinner ?? program.mealDefaults.dinner),
          },
          selfArrangedMeals: MEALS.filter((meal) => program.selfArrangedMeals[meal]),
          preferredActivityIds: [...selectedIds],
          activitiesSelfArranged,
        },
      });
      setSelectedOverride(null);
      setSelfArrangedOverride(null);
      refresh();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : "The activity change failed.");
    } finally {
      setBusy(false);
    }
  }

  async function clearRequirement(tag: ActivityTag): Promise<void> {
    if (!projection) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: projection.trip.revision,
        command: { type: "set_activity_requirement", tag, minimumCount: null },
      });
      refresh();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : "The change failed.");
    } finally {
      setBusy(false);
    }
  }

  const banner = error ? (
    <p role="status" className="rounded border border-clay bg-cream p-3 text-sm text-clay">
      {error.message} Showing the last known state.
    </p>
  ) : reconnecting ? (
    <p role="status" className="text-sm text-ink-muted">
      Live updates reconnecting…
    </p>
  ) : null;

  // Unfinished failed planning outranks any pending decision: it can no longer
  // be answered, so the step must offer owner recovery instead.
  if (projection.trip.recoveryRequired || projection.trip.workflowStatus === "failed") {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <PlanningStoppedCard tripId={tripId} projection={projection} onRetried={refresh} />
      </div>
    );
  }

  if (pendingDecision?.kind === "recovery") {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <RecoveryCard
          decision={pendingDecision}
          tripId={tripId}
          busy={busy}
          error={actionError}
          onChoose={(optionId) =>
            submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "choose_option",
              optionId,
            })
          }
        />
      </div>
    );
  }

  if (program) {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <header className="flex flex-col gap-2">
          <StepIndicator step="activities" />
          <h1 className="text-2xl">Activities</h1>
          <p className="text-sm text-ink-muted">
            These are demo activity choices for your sightseeing day. They are recorded preferences
            and never booked.
          </p>
        </header>
        {preferencesEditable ? (
          <>
            {requirementEntries.length > 0 ? (
              <div className="flex flex-col gap-1" data-testid="activity-requirements">
                <div className="flex flex-wrap items-center gap-2">
                  {requirementEntries.map(([tag, count]) => (
                    <span
                      key={tag}
                      className="flex items-center gap-2 rounded border border-border bg-cream px-3 py-1 text-sm"
                    >
                      Minimum {count} {tag} visit{count === 1 ? "" : "s"}
                      <button
                        type="button"
                        disabled={busy || activeWork}
                        onClick={() => void clearRequirement(tag)}
                        className="text-clay underline disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </span>
                  ))}
                </div>
                <p className="text-sm text-ink-muted">
                  The planner plans only what you request here or pin below; everything else stays free
                  time.
                </p>
              </div>
            ) : null}
            {pendingDecision ? (
              <p role="note" data-testid="activities-replan-note" className="text-sm text-ink-muted">
                Saving your preferences replaces the pending decision and replans the day; the updated
                itinerary asks for approval again.
              </p>
            ) : null}
            <label className="flex w-fit items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="self-arranged-activities"
                checked={activitiesSelfArranged}
                disabled={busy || activeWork}
                onChange={(event) => setSelfArrangedOverride(event.target.checked)}
              />
              I&apos;ll arrange the activities myself
            </label>
            {activitiesSelfArranged ? (
              <p
                role="note"
                data-testid="self-arranged-activities-note"
                className="rounded border border-border bg-cream p-3 text-sm text-ink-muted"
              >
                You arrange the activities yourself. The plan will contain no sightseeing stops; your
                activity preferences are kept for when you opt back in.
              </p>
            ) : null}
            <InterestControls
              tripId={tripId}
              revision={projection.trip.revision}
              pace={projection.trip.preferences.activityPace}
              onChanged={refresh}
            />
            {actionError ? (
              <p role="alert" className="text-sm text-clay">
                {actionError}
              </p>
            ) : null}
            {activitiesSelfArranged ? null : (
              <ul className="flex flex-col gap-2" aria-label="Activity choices">
                {program.activities.map((activity) => (
                  <ActivityCard
                    key={activity.id}
                    activity={activity}
                    selected={selectedIds.includes(activity.id)}
                    disabled={busy || activeWork}
                    planned={plannedById.has(activity.id)}
                    {...(plannedById.has(activity.id)
                      ? { plannedSlot: plannedById.get(activity.id) }
                      : {})}
                    onToggle={() => toggleActivity(activity.id)}
                  />
                ))}
              </ul>
            )}
            {/* Sticky status bar (2026-10-14): the plan state and the Save action
                stay visible while the catalog scrolls. */}
            <div
              data-testid="activity-status-bar"
              className="sticky bottom-0 z-10 flex flex-col gap-2 border border-border bg-paper/90 py-3 px-4"
              >
              {activitiesSelfArranged ? null : (
                <div className="flex flex-col gap-1">
                  <p data-testid="activity-plan-summary" className="text-sm text-ink-muted">
                    {planVisitSummary
                      ? `In your current plan: ${planVisitSummary}. The planner adds nothing beyond your requests and pins (cards marked below).`
                      : "No visits planned yet — the day stays free time apart from the fixed meals and transfers. Ask the assistant (for example \"two museums\") or pin activities below."}
                  </p>
                  {visitBudget === null ? null : visitBudget.selectedCount === 0 ? null : newSelectionCount === 0 ? (
                    <p data-testid="activity-fit-summary" className="text-sm text-ink-muted">
                      Everything you selected is already part of the plan — pinning keeps it in the day
                      (nothing is added twice).
                    </p>
                  ) : visitBudget.fits ? (
                    <p data-testid="activity-fit-summary" className="text-sm text-ink-muted">
                      Pinning adds {newSelectionCount} new{" "}
                      {newSelectionCount === 1 ? "visit" : "visits"}, about{" "}
                      {formatVisitMinutes(newSelectionMinutes)} — your full selection stays within the{" "}
                      {Math.round(visitBudget.capMinutes / 60)} h visit budget of a{" "}
                      {paceKey ?? "standard"} day.
                    </p>
                  ) : (
                    <p
                      role="alert"
                      data-testid="activity-fit-warning"
                      className="rounded border border-clay bg-cream p-3 text-sm text-clay"
                    >
                      Your selection needs about {formatVisitMinutes(visitBudget.selectedMinutes)}, over
                      the {Math.round(visitBudget.capMinutes / 60)} h visit budget of a{" "}
                      {paceKey ?? "standard"} day by {formatVisitMinutes(visitBudget.overMinutes)}. Remove a
                      visit or lower the requirement, then save.
                    </p>
                  )}
                </div>
              )}
              <div>
                <button
                  type="button"
                  disabled={busy || activeWork || (visitBudget !== null && !visitBudget.fits)}
                  onClick={() => void saveActivities()}
                  className="rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Save plan"}
                </button>
            </div>
            <p className="text-sm">
              <Link href={`/trips/${tripId}/itinerary`} className="button-link">
                Continue to the itinerary
              </Link>
            </p>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-muted">
              {pendingDecision?.kind === "program_choices" ? (
                <>
                  Your activity change needs the program re-confirmed:{" "}
                  <Link href={`/trips/${tripId}/meals`} className="underline">
                    review your meals
                  </Link>{" "}
                  and save them to replan the day.
                </>
              ) : (
                <>
                  Activity pace:{" "}
                  <span className="capitalize">{projection.trip.preferences.activityPace}</span>. A
                  pending choice must be answered before preferences can change.
                </>
              )}
            </p>
            {activitiesSelfArranged ? (
              <p
                role="note"
                data-testid="self-arranged-activities-note"
                className="rounded border border-border bg-cream p-3 text-sm text-ink-muted"
              >
                You arrange the activities yourself. The plan will contain no sightseeing stops.
              </p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Activity choices">
                {program.activities.map((activity) => (
                  <ActivityCard
                    key={activity.id}
                    activity={activity}
                    selected={selectedIds.includes(activity.id)}
                    disabled
                    onToggle={() => undefined}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {banner}
      <StatusPanel
        message={activeWork ? "Accepted - preparing activities…" : "Preparing activity options…"}
      />
    </div>
  );
}
