"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type {
  PublicDecisionResponse,
  PublicMealOffer,
  PublicProgramChoices,
  Meal,
} from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { submitCommand, submitDecision } from "@/lib/decision-client";
import { formatEuroMinor } from "@/lib/format/money";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { BookingConfirmationDialog } from "@/components/booking/BookingConfirmationDialog";
import { ChangeServiceButton } from "@/components/booking/ChangeServiceButton";
import { ConfirmationResult } from "@/components/booking/ConfirmationResult";
import { ProposalReview } from "@/components/booking/ProposalReview";
import { RecoveryCard } from "@/components/booking/RecoveryCard";
import { StaleProposalNotice } from "@/components/booking/StaleProposalNotice";
import { OfferCard } from "@/components/offers/OfferCard";
import { OfferGrid } from "@/components/offers/OfferGrid";
import { ServiceLevelSelect } from "@/components/preferences/ServiceLevelSelect";
import { StepIndicator } from "@/components/trip/StepIndicator";
import { ErrorPanel, StatusPanel } from "@/components/wizard/FlightGating";
import { PlanningStoppedCard } from "@/components/wizard/PlanningStoppedCard";
import { ResearchFailurePanel, SimulatedFailureNote } from "@/components/wizard/ResearchGap";

const MEALS: readonly Meal[] = ["breakfast", "lunch", "dinner"];

function mealOfferLabel(meals: readonly PublicMealOffer[], offerId: string | null): string {
  if (!offerId) {
    return "Not included";
  }
  const offer = meals.find((candidate) => candidate.id === offerId);
  return offer ? `${offer.name} · ${formatEuroMinor(offer.partyTotalMinor)}` : offerId;
}

function mealDetails(offer: PublicMealOffer): { label: string; value: string }[] {
  return [
    { label: "Cuisine", value: offer.cuisine },
    { label: "Serving window", value: `${offer.windowStart}–${offer.windowEnd}` },
    { label: "Duration", value: `${offer.durationMinutes} min` },
    { label: "Per adult", value: formatEuroMinor(offer.perAdultMinor) },
    { label: "From centre", value: `${offer.centerDistanceKm.toFixed(1)} km` },
  ];
}

/**
 * Meals step: one tile section per meal (breakfast, lunch, dinner) with its own
 * category select, plus the optional per-meal reservations. Activities live on
 * their own step; saving the program here preserves the current activity
 * preferences.
 */
export function MealsView({ tripId }: { readonly tripId: string }): React.JSX.Element {
  const { projection, error, refresh } = useTripProjection(tripId);
  const onEvent = useCallback(() => refresh(), [refresh]);
  const { reconnecting } = useTripEvents(tripId, onEvent);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mealSelection, setMealSelection] = useState<Record<Meal, string | null> | null>(null);
  const [selfArrangedOverride, setSelfArrangedOverride] = useState<Record<Meal, boolean> | null>(
    null,
  );

  const selfArrangedFlags = useCallback(
    (program: { selfArrangedMeals: Record<Meal, boolean> }): Record<Meal, boolean> =>
      selfArrangedOverride ?? {
        breakfast: program.selfArrangedMeals.breakfast,
        lunch: program.selfArrangedMeals.lunch,
        dinner: program.selfArrangedMeals.dinner,
      },
    [selfArrangedOverride],
  );

  /** Offer id the meal would carry when it is not self-arranged. */
  const offerFor = useCallback(
    (program: PublicProgramChoices | null, meal: Meal): string | null =>
      program?.selectedMeals[meal] ?? program?.mealDefaults[meal] ?? null,
    [],
  );

  const handleError = useCallback(
    (caught: unknown): void => {
      setActionError(
        caught instanceof ApiError ? caught.message : "The request could not be completed.",
      );
      if (
        caught instanceof ApiError &&
        (caught.code === "CONFLICT" ||
          caught.code === "STALE_REVISION" ||
          caught.code.startsWith("STALE_"))
      ) {
        refresh();
      }
    },
    [refresh],
  );

  /** Save a per-meal "I'll arrange it myself" toggle from the saved-program view. */
  const toggleSelfArranged = useCallback(
    async (meal: Meal, next: boolean): Promise<void> => {
      if (!projection?.program) {
        return;
      }
      const program = projection.program;
      const flags: Record<Meal, boolean> = {
        ...selfArrangedFlags(program),
        [meal]: next,
      };
      if (!next && offerFor(program, meal) === null) {
        return;
      }
      const mealOfferIds = {
        breakfast: flags.breakfast ? null : offerFor(program, "breakfast"),
        lunch: flags.lunch ? null : offerFor(program, "lunch"),
        dinner: program.dinnerNotIncludedReason || flags.dinner ? null : offerFor(program, "dinner"),
      };
      setBusy(true);
      setActionError(undefined);
      try {
        await submitCommand(tripId, {
          requestId: crypto.randomUUID(),
          expectedRevision: projection.trip.revision,
          command: {
            type: "set_program",
            mealOfferIds,
            selfArrangedMeals: MEALS.filter((candidate) => flags[candidate]),
            preferredActivityIds: [...program.preferredActivityIds],
            activitiesSelfArranged: program.activitiesSelfArranged,
          },
        });
        setSelfArrangedOverride(null);
        refresh();
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
    [handleError, offerFor, projection, refresh, selfArrangedFlags, tripId],
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
        setDialogOpen(false);
        refresh();
        return true;
      } catch (caught) {
        handleError(caught);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [handleError, refresh, tripId],
  );

  const reserveMeal = useCallback(
    async (meal: Meal, offerId: string): Promise<void> => {
      setBusy(true);
      setActionError(undefined);
      try {
        await submitCommand(tripId, {
          requestId: crypto.randomUUID(),
          expectedRevision: projection?.trip.revision ?? 0,
          command: { type: "propose_selection", service: meal, offerId },
        });
        refresh();
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
    [handleError, projection, refresh, tripId],
  );

  const activeOperation = useMemo(
    () =>
      projection?.operations.find(
        (operation) => operation.status === "queued" || operation.status === "running",
      ),
    [projection],
  );
  const activeWork = activeOperation !== undefined;

  if (!projection) {
    if (error) {
      return <ErrorPanel message={error.message} onRetry={refresh} />;
    }
    return <StatusPanel message="Loading your meal options…" />;
  }

  const {
    meals,
    program,
    pendingDecision,
    proposal,
    reservations,
    serviceLevels,
    searchObjectives,
  } = projection;
  const confirmedMeals = reservations.filter(
    (reservation) =>
      reservation.status === "confirmed" &&
      reservation.serviceKey !== "flights" &&
      reservation.serviceKey !== "hotel",
  );

  // A per-meal "Change" submits a `find_alternatives` command, which the graph
  // applies through its `modify` branch even while a decision is pending
  // (Phase 11), so the saved program stays editable during the itinerary
  // approval and an open clarification — the same principle as the activities
  // step. A decision that must be answered elsewhere (a live hotel/flight
  // choice, a staged booking confirmation, recovery) keeps the step read-only.
  const changesEditable =
    pendingDecision === null ||
    pendingDecision.kind === "itinerary_approval" ||
    pendingDecision.kind === "clarification";

  const banner = error ? (
    <p role="status" className="rounded border border-clay bg-cream p-3 text-sm text-clay">
      {error.message} Showing the last known state.
    </p>
  ) : reconnecting ? (
    <p role="status" className="text-sm text-ink-muted">
      Live updates reconnecting…
    </p>
  ) : null;
  // Unfinished failed planning always wins: a pending decision that can no
  // longer be answered must not present a Save button that silently conflicts.
  if (projection.trip.recoveryRequired || projection.trip.workflowStatus === "failed") {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <PlanningStoppedCard tripId={tripId} projection={projection} onRetried={refresh} />
      </div>
    );
  }

  if (pendingDecision?.kind === "program_choices" && program) {
    const dinnerOptional = program.dinnerNotIncludedReason !== null;
    const selfArranged = selfArrangedFlags(program);
    const confirmedMealServices = new Set(confirmedMeals.map((row) => row.serviceKey));
    const selection: Record<Meal, string | null> = mealSelection ?? {
      breakfast: program.selectedMeals.breakfast ?? program.mealDefaults.breakfast,
      lunch: program.selectedMeals.lunch ?? program.mealDefaults.lunch,
      // An excluded dinner is never selectable, even if a stale selection exists.
      dinner: dinnerOptional
        ? null
        : (program.selectedMeals.dinner ?? program.mealDefaults.dinner),
    };
    const ready = MEALS.every(
      (meal) =>
        selfArranged[meal] ||
        selection[meal] !== null ||
        (meal === "dinner" && dinnerOptional),
    );
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <header className="flex flex-col gap-2">
          <StepIndicator step="meals" />
          <h1 className="text-2xl">Plan your day</h1>
          <p className="text-sm text-ink-muted">
            Choose one option per meal; activities live on their own step. Selecting a meal here does
            not book it; restaurant reservations are optional and confirmed separately. Tick
            &quot;I&apos;ll arrange it myself&quot; to leave a meal out of the plan.
          </p>
        </header>
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
        <SimulatedFailureNote
          state={
            MEALS.map(
              (meal) =>
                projection.research?.domains.find((entry) => entry.domain === meal) ?? null,
            ).find((state) => state?.simulatedFailure) ?? null
          }
        />
        {MEALS.map((meal) => {
          const offers = meals.filter((offer) => offer.meal === meal);
          const dinnerBlocked = meal === "dinner" && dinnerOptional;
          const isSelfArranged = selfArranged[meal];
          const confirmedHere = confirmedMealServices.has(meal);
          return (
            <section key={meal} className="flex flex-col gap-3" aria-label={`${meal} options`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg capitalize">{meal}</h2>
                {!dinnerBlocked ? (
                  <label
                    className="flex items-center gap-2 text-sm"
                    title={
                      confirmedHere
                        ? `A confirmed ${meal} reservation keeps this meal in the plan; cancel it first.`
                        : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      data-testid={`self-arranged-${meal}`}
                      checked={isSelfArranged}
                      disabled={busy || activeWork || confirmedHere}
                      onChange={(event) =>
                        setSelfArrangedOverride({
                          ...selfArranged,
                          [meal]: event.target.checked,
                        })
                      }
                    />
                    I&apos;ll arrange this {meal} myself
                  </label>
                ) : null}
              </div>
              {dinnerBlocked ? (
                // The deterministic slot check excluded dinner: no category and no
                // tiles are offered, only the prominent reason.
                <div
                  role="note"
                  data-testid="dinner-not-included"
                  className="flex flex-col gap-1 rounded border border-clay bg-cream p-3 text-sm text-clay"
                >
                  <p className="font-medium">Dinner is not included in this trip</p>
                  <p>{program.dinnerNotIncludedReason}</p>
                </div>
              ) : isSelfArranged ? (
                <p
                  role="note"
                  data-testid={`self-arranged-note-${meal}`}
                  className="rounded border border-border bg-cream p-3 text-sm text-ink-muted"
                >
                  You arrange the {meal} yourself. It will not be included in the plan or the cost
                  breakdown.
                </p>
              ) : (
                <>
                  <ServiceLevelSelect
                    tripId={tripId}
                    revision={projection.trip.revision}
                    service={meal}
                    label={meal}
                    levelState={serviceLevels[meal]}
                    customObjective={searchObjectives[meal]}
                    onChanged={refresh}
                  />
                  {offers.length === 0 ? (
                    <p className="text-sm text-ink-muted">
                      No {meal} offers are available for this category.
                    </p>
                  ) : (
                    <OfferGrid label={`${meal} offers`}>
                      {offers.map((offer) => (
                        <OfferCard
                          key={offer.id}
                          title={offer.name}
                          subtitle={`${offer.level} · ${offer.cuisine} · ${offer.durationMinutes} min`}
                          priceMinor={offer.partyTotalMinor}
                          priceNote={`total for ${projection.trip.adults} adults`}
                          details={mealDetails(offer)}
                          demoLabels={offer.demoLabels}
                          actionLabel={
                            selection[meal] === offer.id ? "Selected" : `Choose this ${meal}`
                          }
                          selected={selection[meal] === offer.id}
                          disabled={busy || activeWork}
                          testId={`meal-offer-${meal}`}
                          onAction={() => setMealSelection({ ...selection, [meal]: offer.id })}
                        />
                      ))}
                    </OfferGrid>
                  )}
                </>
              )}
            </section>
          );
        })}
        <div>
          <button
            type="button"
            disabled={busy || activeWork || !ready}
            onClick={() =>
              void submitResponse(pendingDecision.id, projection.trip.revision, {
                action: "submit_program",
                mealOfferIds: {
                  breakfast: selfArranged.breakfast ? null : selection.breakfast,
                  lunch: selfArranged.lunch ? null : selection.lunch,
                  dinner: dinnerOptional || selfArranged.dinner ? null : selection.dinner,
                },
                selfArrangedMeals: MEALS.filter((meal) => selfArranged[meal]),
                preferredActivityIds: [...program.preferredActivityIds],
                activitiesSelfArranged: program.activitiesSelfArranged,
              })
            }
            className="rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            {busy
              ? "Saving…"
              : activeOperation?.progress?.programSaved
                ? "Selections saved"
                : activeWork
                  ? "Request accepted"
                  : "Save program"}
          </button>
        </div>
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

  const mealService = proposal?.serviceKey;
  const isMealService =
    mealService === "breakfast" || mealService === "lunch" || mealService === "dinner";
  if (
    (pendingDecision?.kind === "booking_confirmation" ||
      pendingDecision?.kind === "replacement_confirmation") &&
    pendingDecision
  ) {
    const staleProposalId = proposal?.id ?? pendingDecision.proposalId;
    if (!proposal || proposal.expired) {
      return (
        <div className="flex flex-col gap-6">
          {banner}
          <StaleProposalNotice
            serviceLabel={isMealService && mealService ? mealService : "meal"}
            busy={busy}
            canReselect={Boolean(staleProposalId)}
            onReselect={() => {
              if (staleProposalId) {
                void submitResponse(pendingDecision.id, projection.trip.revision, {
                  action: "reject_proposal",
                  proposalId: staleProposalId,
                });
              }
            }}
          />
        </div>
      );
    }
    if (isMealService && mealService) {
      return (
        <div className="flex flex-col gap-6">
          {banner}
          <ProposalReview
            title={`Confirm your ${mealService} reservation`}
            description="Restaurant reservations are optional. Confirm to create the simulated reservation, or choose a different option."
            proposal={proposal}
            reviewLabel="Review reservation"
            busy={busy}
            onReview={() => setDialogOpen(true)}
            onReject={() =>
              void submitResponse(pendingDecision.id, projection.trip.revision, {
                action: "reject_proposal",
                proposalId: proposal.id,
              })
            }
          />
          <BookingConfirmationDialog
            open={dialogOpen}
            heading="Confirm this simulated restaurant booking"
            busy={busy}
            error={actionError}
            onCancel={() => setDialogOpen(false)}
            onReject={() => {
              setDialogOpen(false);
              void submitResponse(pendingDecision.id, projection.trip.revision, {
                action: "reject_proposal",
                proposalId: proposal.id,
              });
            }}
            rejectLabel="Choose a different option"
            onConfirm={() =>
              void submitResponse(pendingDecision.id, projection.trip.revision, {
                action: "confirm_booking",
                proposalId: proposal.id,
                acceptedDemoDisclaimer: true,
              })
            }
            summary={
              <p className="text-sm">
                {mealOfferLabel(meals, proposal.offerId)} —{" "}
                <span className="font-semibold">{formatEuroMinor(proposal.partyTotalMinor)}</span>
              </p>
            }
          />
        </div>
      );
    }
  }

  if (program || confirmedMeals.length > 0) {
    const selfArranged = program ? selfArrangedFlags(program) : null;
    const confirmedMealServices = new Set(confirmedMeals.map((row) => row.serviceKey));
    return (
      <div className="flex flex-col gap-6">
        {banner}
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
        <header className="flex flex-col gap-2">
          <StepIndicator step="meals" />
          <h1 className="text-2xl">Meals</h1>
          <p className="text-sm text-ink-muted">
            Meal selections are saved. Restaurant reservations are optional and confirmed one meal
            at a time. Tick &quot;I&apos;ll arrange it myself&quot; to leave a meal out of the plan.
          </p>
        </header>
        {changesEditable ? (
          pendingDecision ? (
            <p role="note" data-testid="meals-change-note" className="text-sm text-ink-muted">
              Changing a meal replaces the pending decision and replans the day; the updated
              itinerary asks for approval again.
            </p>
          ) : null
        ) : pendingDecision ? (
          <p role="note" data-testid="meals-readonly-note" className="text-sm text-ink-muted">
            A pending choice must be answered before the meals can change.
          </p>
        ) : null}
        <ul className="flex flex-col gap-2" aria-label="Saved meal choices">
          {MEALS.map((meal) => {
            const blocked = meal === "dinner" && Boolean(program?.dinnerNotIncludedReason);
            const isSelfArranged = selfArranged?.[meal] ?? false;
            const confirmedHere = confirmedMealServices.has(meal);
            const offerId = offerFor(program, meal);
            return (
              <li
                key={meal}
                className="flex flex-wrap items-center justify-between gap-3 rounded border border-border p-3 text-sm"
              >
                <div className="flex flex-col">
                  <span className="capitalize text-ink-muted">{meal}</span>
                  <span>
                    {isSelfArranged
                      ? "You arrange this yourself — not part of the plan."
                      : blocked
                        ? "Not included"
                        : mealOfferLabel(meals, offerId)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {changesEditable && !blocked && !isSelfArranged ? (
                    <ChangeServiceButton
                      tripId={tripId}
                      service={meal}
                      label={meal}
                      onChanged={refresh}
                    />
                  ) : null}
                  {program && !blocked && !confirmedHere ? (
                    <label
                      className="flex items-center gap-2"
                      title={
                        !isSelfArranged && offerId === null
                          ? `No ${meal} offer is available, so this meal cannot rejoin the plan.`
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        data-testid={`saved-self-arranged-${meal}`}
                        checked={isSelfArranged}
                        disabled={busy || activeWork || (!isSelfArranged && offerId === null)}
                        onChange={(event) => void toggleSelfArranged(meal, event.target.checked)}
                      />
                      I&apos;ll arrange it myself
                    </label>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {program?.dinnerNotIncludedReason ? (
          <div
            role="note"
            data-testid="dinner-not-included"
            className="flex flex-col gap-1 rounded border border-clay bg-cream p-3 text-sm text-clay"
          >
            <p className="font-medium">Dinner is not included in this trip</p>
            <p>{program.dinnerNotIncludedReason}</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-3">
          {MEALS.map((meal) => {
            const offerId = offerFor(program, meal);
            const already = confirmedMeals.some((row) => row.serviceKey === meal);
            const blocked = meal === "dinner" && program?.dinnerNotIncludedReason;
            const isSelfArranged = selfArranged?.[meal] ?? false;
            if (!offerId || already || blocked || isSelfArranged) {
              return null;
            }
            return (
              <button
                key={meal}
                type="button"
                disabled={busy || activeWork}
                onClick={() => void reserveMeal(meal, offerId)}
                className="w-fit rounded border border-teal px-4 py-2 text-sm text-teal disabled:opacity-50"
              >
                Reserve {meal}
              </button>
            );
          })}
        </div>
        {confirmedMeals.map((reservation) => (
          <ConfirmationResult key={reservation.id} reservation={reservation} tripId={tripId} />
        ))}
        <p className="text-sm">
          <Link href={`/trips/${tripId}/activities`} className="button-link">
            Go to activities
          </Link>
        </p>
      </div>
    );
  }

  const failedMeals = MEALS.flatMap((meal) => {
    const state = projection.research?.domains.find((entry) => entry.domain === meal) ?? null;
    return state && state.status !== "ok" && state.status !== "pending" ? [{ meal, state }] : [];
  });

  return (
    <div className="flex flex-col gap-4">
      {banner}
      {failedMeals.length > 0 && pendingDecision === null ? (
        <div className="flex flex-col gap-6">
          {failedMeals.map(({ meal, state }) => (
            <ResearchFailurePanel
              key={meal}
              tripId={tripId}
              revision={projection.trip.revision}
              domain={meal}
              state={state}
              disabled={activeWork}
              onRetried={refresh}
            />
          ))}
          <div className="grid gap-3 sm:grid-cols-3">
            {failedMeals.map(({ meal }) => (
              <ServiceLevelSelect
                key={meal}
                tripId={tripId}
                revision={projection.trip.revision}
                service={meal}
                label={meal}
                levelState={serviceLevels[meal]}
                customObjective={searchObjectives[meal]}
                onChanged={refresh}
              />
            ))}
          </div>
        </div>
      ) : (
        <StatusPanel
          message={activeWork ? "Accepted - preparing meals…" : "Preparing meal options…"}
        />
      )}
    </div>
  );
}