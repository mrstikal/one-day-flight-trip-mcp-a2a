"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/api-client";
import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { submitCommand, submitDecision } from "@/lib/decision-client";
import { formatLocalDate } from "@/lib/format/datetime";
import { hasSavedProgram, nextTripStep } from "@/lib/trip-step";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { RecoveryCard } from "@/components/booking/RecoveryCard";
import { ApprovalDialog } from "@/components/itinerary/approval-dialog";
import { CostBreakdown } from "@/components/itinerary/cost-breakdown";
import { Timeline } from "@/components/itinerary/timeline";
import { ValidationSummary } from "@/components/itinerary/validation-summary";
import { MapPanel } from "@/components/map/map-panel";
import { StepIndicator } from "@/components/trip/StepIndicator";
import { ErrorPanel, StatusPanel } from "@/components/wizard/FlightGating";
import { PlanningStoppedCard } from "@/components/wizard/PlanningStoppedCard";

/**
 * Itinerary page (Phase 10 section 7): chronological destination-local timeline,
 * validation summary anchored to events, draft/approved state, cost breakdown,
 * the client-only map with offline fallback, and the approval dialog. Approval
 * only appears while the `itinerary_approval` decision is pending and is
 * disabled while blocking errors remain.
 */
export function ItineraryView({ tripId }: { readonly tripId: string }): React.JSX.Element {
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
          caught.code === "STALE_ITINERARY" ||
          caught.code.startsWith("STALE_"))
      ) {
        refresh();
      }
    },
    [refresh],
  );

  const build = useCallback(async (): Promise<void> => {
    if (!projection) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: projection.trip.revision,
        command: { type: "build_itinerary" },
      });
      refresh();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }, [handleError, projection, refresh, tripId]);

  const approve = useCallback(async (): Promise<void> => {
    if (!projection?.itinerary || !projection.pendingDecision) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await submitDecision({
        tripId,
        decisionId: projection.pendingDecision.id,
        expectedRevision: projection.trip.revision,
        response: { action: "approve_itinerary", itineraryId: projection.itinerary.id },
      });
      setDialogOpen(false);
      refresh();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }, [handleError, projection, refresh, tripId]);

  const chooseRecovery = useCallback(
    async (optionId: string): Promise<boolean> => {
      if (!projection?.pendingDecision) {
        return false;
      }
      setBusy(true);
      setActionError(undefined);
      try {
        await submitDecision({
          tripId,
          decisionId: projection.pendingDecision.id,
          expectedRevision: projection.trip.revision,
          response: { action: "choose_option", optionId },
        });
        refresh();
        return true;
      } catch (caught) {
        handleError(caught);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [handleError, projection, refresh, tripId],
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
    return <StatusPanel message="Loading your itinerary…" />;
  }

  // Unfinished failed planning outranks any pending decision: it can no longer
  // be answered, so the page must offer owner recovery instead.
  if (projection.trip.recoveryRequired || projection.trip.workflowStatus === "failed") {
    return (
      <section className="flex flex-col gap-4">
        <PlanningStoppedCard tripId={tripId} projection={projection} onRetried={refresh} />
      </section>
    );
  }

  const itinerary = projection.itinerary;
  const pending = projection.pendingDecision;
  const approvalPending = pending?.kind === "itinerary_approval";
  const blockingErrors = itinerary?.validation.errors.length ?? 0;

  if (!itinerary) {
    const step = nextTripStep({
      tripId,
      reservations: projection.reservations,
      hasProgram: hasSavedProgram(projection.program),
      hasItinerary: false,
      flightSelected: projection.selections.flights.offerId !== null,
      hotelSelected: projection.selections.hotel.offerId !== null,
      pendingDecisionKind: projection.pendingDecision?.kind ?? null,
      proposalServiceKey: projection.proposal?.serviceKey ?? null,
    });
    return (
      <section className="flex flex-col gap-4">
        <header className="flex flex-col gap-2">
          <StepIndicator step="itinerary" />
          <h1 className="text-2xl">Itinerary</h1>
          <p className="text-sm text-ink-muted">
            No itinerary version exists yet. Planning starts automatically after you save your
            program; you can also rebuild it once a flight, hotel, and program are in place.
          </p>
        </header>
        {activeWork ? (
          <StatusPanel message="Planning your sightseeing day…" />
        ) : (
          <button
            type="button"
            data-testid="build-itinerary"
            onClick={() => void build()}
            disabled={busy || pending !== null}
            className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            {busy ? "Building…" : "Build itinerary"}
          </button>
        )}
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
        {step ? (
          <p className="text-sm">
            <Link href={step.href} className="underline">
              {step.cta}
            </Link>
          </p>
        ) : null}
        <p role="note" className="text-sm text-ink-muted">
          {DEMO_DISCLAIMER}
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <StepIndicator step="itinerary" />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl">Itinerary</h1>
          <span
            data-testid="itinerary-status"
            className={`rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
              itinerary.status === "approved"
                ? "bg-teal text-paper"
                : "border border-clay text-clay"
            }`}
          >
            {itinerary.status === "approved" ? "Approved" : "Draft"}
          </span>
          <span className="text-sm text-ink-muted" data-testid="itinerary-version">
            Version {itinerary.version} · {formatLocalDate(itinerary.sightseeingDate)} ·{" "}
            {itinerary.adults} {itinerary.adults === 1 ? "adult" : "adults"} · {itinerary.zone}
          </span>
          {itinerary.status === "draft" && itinerary.approvedVersion !== null ? (
            <span className="text-sm text-ink-muted">
              Replaces approved version {itinerary.approvedVersion} when approved.
            </span>
          ) : null}
        </div>
      </header>

      {projection.pendingDecision?.kind === "clarification" ? (
        <p role="status" className="rounded border border-clay bg-cream p-3 text-sm text-clay">
          The plan has a conflict that needs your decision in the assistant before approval can
          continue.
        </p>
      ) : null}

      {pending?.kind === "recovery" ? (
        <RecoveryCard
          decision={pending}
          tripId={tripId}
          busy={busy}
          error={actionError}
          onChoose={chooseRecovery}
        />
      ) : null}

      {itinerary.selfArranged.meals.length > 0 || itinerary.selfArranged.activities ? (
        <p
          role="note"
          data-testid="self-arranged-note"
          className="rounded border border-border bg-cream p-3 text-sm text-ink-muted"
        >
          You arrange these yourself, so they are not part of this plan:{" "}
          {[
            ...itinerary.selfArranged.meals.map(
              (meal) => `${meal.charAt(0).toUpperCase()}${meal.slice(1)}`,
            ),
            ...(itinerary.selfArranged.activities ? ["activities"] : []),
          ].join(", ")}
          .
        </p>
      ) : null}

      <ValidationSummary itinerary={itinerary} />

      {approvalPending ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            data-testid="open-approval"
            onClick={() => setDialogOpen(true)}
            disabled={blockingErrors > 0}
            className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            Review and approve
          </button>
          {blockingErrors > 0 ? (
            <p className="text-sm text-clay">
              Approval is disabled while blocking validation errors remain.
            </p>
          ) : null}
        </div>
      ) : itinerary.status === "approved" ? (
        <p data-testid="approved-note" className="text-sm text-teal">
          This version is approved. A later change creates a new draft without modifying it.
        </p>
      ) : pending === null && !activeWork ? (
        <button
          type="button"
          data-testid="rebuild-itinerary"
          onClick={() => void build()}
          disabled={busy}
          className="w-fit rounded border border-teal px-3 py-1 text-sm text-teal disabled:opacity-50"
        >
          {busy ? "Rebuilding…" : "Rebuild itinerary"}
        </button>
      ) : null}

      <Timeline
        events={itinerary.events}
        zone={itinerary.zone}
        issues={[...itinerary.validation.errors, ...itinerary.validation.warnings]}
      />

      <CostBreakdown
        itinerary={itinerary}
        notBooked={(
          [
            { category: "flights" as const, selection: projection.selections.flights },
            { category: "hotel" as const, selection: projection.selections.hotel },
          ]
        )
          .filter((entry) => entry.selection.offerId !== null && !entry.selection.booked)
          .map((entry) => entry.category)}
      />

      <MapPanel markers={itinerary.markers} tileUrl={projection.display.mapTileUrl} />

      {actionError ? (
        <p role="alert" className="text-sm text-clay">
          {actionError}
        </p>
      ) : null}
      {reconnecting ? (
        <p role="status" className="text-xs text-ink-muted">
          Reconnecting to live updates…
        </p>
      ) : null}
      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>

      <ApprovalDialog
        open={dialogOpen}
        itinerary={itinerary}
        canApprove={blockingErrors === 0}
        busy={busy}
        error={actionError}
        onConfirm={() => void approve()}
        onCancel={() => setDialogOpen(false)}
      />
    </div>
  );
}