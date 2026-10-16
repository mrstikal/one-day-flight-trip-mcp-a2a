"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { PublicDecisionResponse, PublicHotelOffer } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { submitCommand, submitDecision } from "@/lib/decision-client";
import { formatLocalDate } from "@/lib/format/datetime";
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

function hotelDetails(offer: PublicHotelOffer): { label: string; value: string }[] {
  return [
    { label: "Check-in", value: formatLocalDate(offer.date) },
    { label: "Nights", value: String(offer.nights) },
    { label: "Rooms", value: String(offer.rooms) },
    { label: "Per night", value: formatEuroMinor(offer.perNightMinor) },
    { label: "Rating", value: offer.rating.toFixed(1) },
    { label: "From centre", value: `${offer.centerDistanceKm.toFixed(1)} km` },
    { label: "Luggage storage", value: offer.luggageStorage ? "Available" : "Not available" },
    { label: "Category", value: offer.level },
  ];
}

/** Hotel step: gating, offers, hotel choice, and the demo booking dialog. */
export function HotelView({ tripId }: { readonly tripId: string }): React.JSX.Element {
  const { projection, error, refresh } = useTripProjection(tripId);
  const onEvent = useCallback(() => refresh(), [refresh]);
  const { reconnecting } = useTripEvents(tripId, onEvent);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);

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

  const activeWork = useMemo(
    () =>
      projection?.operations.some(
        (operation) => operation.status === "queued" || operation.status === "running",
      ) ?? false,
    [projection],
  );

  // The trip can be left at the hotel step without a waiting decision when an
  // earlier chat operation ended without one. Nothing is preparing then, so the
  // user needs an explicit way to re-derive the offers and continue the step.
  const showHotelOptions = useCallback(async (): Promise<void> => {
    if (!projection) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: projection.trip.revision,
        command: { type: "find_alternatives", target: "hotel", objective: "match_preferences" },
      });
      refresh();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }, [handleError, projection, refresh, tripId]);

  // "I don't want to book" is a trusted decision response: it declines the
  // simulated reservation for the staged hotel but keeps the offer as the trip's
  // selection, so the plan is built as if the hotel existed.
  const declineHotelBooking = useCallback(
    async (decisionId: string, revision: number, proposalId: string): Promise<void> => {
      setBusy(true);
      setActionError(undefined);
      try {
        await submitDecision({
          tripId,
          decisionId,
          expectedRevision: revision,
          response: { action: "decline_booking", proposalId },
        });
        setDialogOpen(false);
        refresh();
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
    [handleError, refresh, tripId],
  );

  // A late booking for the kept selection: staging the same offer as a proposal
  // opens the ordinary review dialog, which can still be declined.
  const bookSelectedHotel = useCallback(
    async (offerId: string): Promise<void> => {
      if (!projection) {
        return;
      }
      setBusy(true);
      setActionError(undefined);
      try {
        await submitCommand(tripId, {
          requestId: crypto.randomUUID(),
          expectedRevision: projection.trip.revision,
          command: { type: "propose_selection", service: "hotel", offerId },
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

  if (!projection) {
    if (error) {
      return <ErrorPanel message={error.message} onRetry={refresh} />;
    }
    return <StatusPanel message="Loading your hotel options…" />;
  }

  const { hotel, pendingDecision, proposal, reservations, serviceLevels } = projection;
  const confirmedHotel = reservations.find(
    (reservation) => reservation.serviceKey === "hotel" && reservation.status === "confirmed",
  );
  const hotelResearch =
    projection.research?.domains.find((entry) => entry.domain === "hotel") ?? null;

  // "Change hotel" submits a `find_alternatives` command, which the graph applies
  // through its `modify` branch even while a decision is pending (Phase 11), so
  // the settled step stays editable during the itinerary approval and an open
  // clarification — the same principle as the activities step. A decision that
  // must be answered elsewhere (a live hotel/flight choice, a staged booking
  // confirmation, the meal program step, recovery) keeps the step read-only.
  const changesEditable =
    pendingDecision === null ||
    pendingDecision.kind === "itinerary_approval" ||
    pendingDecision.kind === "clarification";
  const changeControls = (
    <>
      {changesEditable ? (
        <>
          {pendingDecision ? (
            <p role="note" data-testid="hotel-change-note" className="text-sm text-ink-muted">
              Choosing a different hotel replaces the pending decision and replans the day; the
              updated itinerary asks for approval again.
            </p>
          ) : null}
          <ChangeServiceButton
            tripId={tripId}
            service="hotel"
            label="hotel"
            onChanged={refresh}
          />
        </>
      ) : pendingDecision ? (
        <p role="note" data-testid="hotel-readonly-note" className="text-sm text-ink-muted">
          A pending choice must be answered before the hotel can change.
        </p>
      ) : null}
    </>
  );

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

  if (pendingDecision?.kind === "hotel_choice") {
    const selectedId = proposal?.serviceKey === "hotel" ? proposal.offerId : null;
    return (
      <div className="flex flex-col gap-6">
        {banner}
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
        <header className="flex flex-col gap-2">
          <StepIndicator step="hotel" />
          <h1 className="text-2xl">Choose your hotel</h1>
          <p className="text-sm text-ink-muted">
            Simulated offers in EUR. Selecting a card starts a review; nothing is booked yet.
          </p>
        </header>
        <ServiceLevelSelect
          tripId={tripId}
          revision={projection.trip.revision}
          service="hotel"
          label="Hotel"
          levelState={serviceLevels.hotel}
          customObjective={projection.searchObjectives.hotel}
          onChanged={refresh}
        />
        <SimulatedFailureNote state={hotelResearch} />
        {hotel.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No hotel offers are available for your selection.
          </p>
        ) : (
          <OfferGrid label="Hotel offers">
            {hotel.map((offer) => (
              <OfferCard
                key={offer.id}
                title={offer.name}
                subtitle={`${offer.level} · ${offer.nights} night(s)`}
                priceMinor={offer.partyTotalMinor}
                priceNote={`total for ${offer.adults} adults`}
                details={hotelDetails(offer)}
                demoLabels={offer.demoLabels}
                actionLabel={selectedId === offer.id ? "Selected" : "Choose this hotel"}
                selected={selectedId === offer.id}
                disabled={busy || activeWork}
                testId="hotel-offer"
                onAction={() =>
                  void submitResponse(pendingDecision.id, projection.trip.revision, {
                    action: "choose_offer",
                    offerId: offer.id,
                  })
                }
              />
            ))}
          </OfferGrid>
        )}
        <p className="text-sm">
          <Link href={`/trips/${tripId}/flights`} className="underline">
            Back to flights
          </Link>
        </p>
      </div>
    );
  }

  if (
    (pendingDecision?.kind === "booking_confirmation" ||
      pendingDecision?.kind === "replacement_confirmation") &&
    (proposal === null || proposal.serviceKey === "hotel")
  ) {
    if (proposal === null || proposal.expired) {
      const staleProposalId = proposal?.id ?? pendingDecision.proposalId;
      return (
        <div className="flex flex-col gap-6">
          {banner}
          <StaleProposalNotice
            serviceLabel="hotel"
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
    const selected = hotel.find((offer) => offer.id === proposal.offerId) ?? null;
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <ProposalReview
          title="Review and confirm your hotel"
          description="Your selected hotel is staged as a review proposal. Confirm to create the simulated reservation, choose a different hotel, or decline the booking."
          proposal={proposal}
          reviewLabel="Review booking"
          busy={busy}
          onReview={() => setDialogOpen(true)}
          onReject={() =>
            void submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "reject_proposal",
              proposalId: proposal.id,
            })
          }
        />
        {pendingDecision.kind === "booking_confirmation" ? (
          <button
            type="button"
            disabled={busy || activeWork}
            data-testid="decline-hotel-booking"
            onClick={() =>
              void declineHotelBooking(pendingDecision.id, projection.trip.revision, proposal.id)
            }
            className="w-fit rounded border border-border px-4 py-2 text-sm disabled:opacity-50"
          >
            I don&apos;t want to book
          </button>
        ) : null}
        <BookingConfirmationDialog
          open={dialogOpen}
          heading="Confirm this simulated hotel booking"
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
          rejectLabel="Choose a different hotel"
          onConfirm={() =>
            void submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "confirm_booking",
              proposalId: proposal.id,
              acceptedDemoDisclaimer: true,
            })
          }
          summary={
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-ink-muted">Hotel</dt>
              <dd>{selected?.name ?? "Selected hotel"}</dd>
              <dt className="text-ink-muted">Total price</dt>
              <dd className="font-semibold">{formatEuroMinor(proposal.partyTotalMinor)}</dd>
            </dl>
          }
        />
      </div>
    );
  }

  if (confirmedHotel) {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <ConfirmationResult
          reservation={confirmedHotel}
          tripId={tripId}
          nextHref={`/trips/${tripId}/meals`}
          nextLabel="Continue to meals"
        />
        {changesEditable ? (
          <ServiceLevelSelect
            tripId={tripId}
            revision={projection.trip.revision}
            service="hotel"
            label="Hotel"
            levelState={serviceLevels.hotel}
            customObjective={projection.searchObjectives.hotel}
            onChanged={refresh}
          />
        ) : null}
        {changeControls}
        <p role="note" className="text-sm text-ink-muted">
          {DEMO_DISCLAIMER}
        </p>
      </div>
    );
  }

  // A declined booking ("I don't want to book") keeps the chosen hotel as the
  // trip's selection: the step is settled, the plan treats the hotel as if it
  // existed, and the later booking stays one click away.
  const keptHotel =
    projection.selections.hotel.offerId !== null
      ? (hotel.find((offer) => offer.id === projection.selections.hotel.offerId) ?? null)
      : null;
  if (keptHotel) {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl">Your hotel</h1>
          <span
            data-testid="hotel-not-booked"
            className="rounded border border-clay bg-cream px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-clay"
          >
            Not booked
          </span>
        </header>
        <p role="note" className="rounded bg-info p-3 text-sm text-clay">
          No simulated reservation exists for this hotel; you arrange the booking yourself. The day
          plan is still built around it, including its cost and the transfer from the airport.
        </p>
        <OfferGrid label="Selected hotel">
          <OfferCard
            title={keptHotel.name}
            subtitle={`${keptHotel.level} · ${keptHotel.nights} night(s)`}
            priceMinor={keptHotel.partyTotalMinor}
            priceNote={`total for ${keptHotel.adults} adults`}
            details={hotelDetails(keptHotel)}
            demoLabels={keptHotel.demoLabels}
            actionLabel="Book this hotel"
            selected
            disabled={busy || activeWork}
            testId="selected-hotel-offer"
            onAction={() => void bookSelectedHotel(keptHotel.id)}
          />
        </OfferGrid>
        {changesEditable ? (
          <ServiceLevelSelect
            tripId={tripId}
            revision={projection.trip.revision}
            service="hotel"
            label="Hotel"
            levelState={serviceLevels.hotel}
            customObjective={projection.searchObjectives.hotel}
            onChanged={refresh}
          />
        ) : null}
        {changeControls}
        <p className="text-sm">
          <Link href={`/trips/${tripId}/meals`} className="button-link">
            Continue to meals
          </Link>
        </p>
      </div>
    );
  }

  if (
    hotelResearch &&
    hotelResearch.status !== "ok" &&
    hotelResearch.status !== "pending" &&
    pendingDecision === null
  ) {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <ResearchFailurePanel
          tripId={tripId}
          revision={projection.trip.revision}
          domain="hotel"
          state={hotelResearch}
          disabled={activeWork}
          onRetried={refresh}
        />
        <ServiceLevelSelect
          tripId={tripId}
          revision={projection.trip.revision}
          service="hotel"
          label="Hotel"
          levelState={serviceLevels.hotel}
          customObjective={projection.searchObjectives.hotel}
          onChanged={refresh}
        />
        <p className="text-sm">
          <Link href={`/trips/${tripId}/flights`} className="underline">
            Back to flights
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {banner}
      <StatusPanel
        message={activeWork ? "Accepted - preparing hotel offers…" : "Preparing hotel options…"}
      />
      {!activeWork ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-muted">
            No hotel decision is waiting for you. Re-derive the offers to continue this step.
          </p>
          <button
            type="button"
            data-testid="show-hotel-options"
            disabled={busy}
            onClick={() => void showHotelOptions()}
            className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            {busy ? "Preparing…" : "Show hotel options"}
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-sm text-clay">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
