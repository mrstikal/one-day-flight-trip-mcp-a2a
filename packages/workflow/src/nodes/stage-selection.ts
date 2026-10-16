import { InvalidUpdateError } from "@langchain/langgraph";
import { fingerprint } from "@odft/domain";
import type { BookableKey } from "@odft/contracts";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Stage the chosen offer as a review-only proposal and bind the upcoming booking
 * confirmation to it. The proposal's source fingerprint is derived
 * deterministically so the pending-decision row and the proposal agree.
 *
 * The service comes from `bookingService` (flights/hotel/meal), so the same node
 * serves flight, hotel, and per-meal selections without duplicating guards.
 */
export async function stageSelectionNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const offerId = state.lastOfferId ?? state.selectedOfferId;
  if (!offerId) {
    throw new InvalidUpdateError("stage_selection requires a chosen offer");
  }
  if (!state.allowedOfferIds.includes(offerId)) {
    throw new InvalidUpdateError("the chosen offer is not among the offered ids");
  }
  const service: BookableKey = state.bookingService ?? "flights";
  const sourceFingerprint = fingerprint({
    kind: "booking_confirmation",
    tripId: state.tripId,
    operationId: state.operationId,
    service,
    offerId,
    snapshotId: state.snapshotId,
  });
  const ports = travelPorts(runtime);
  // `propose` is idempotent through its own effect ledger inside the booking
  // transaction, so it is called directly (never wrapped in a second effect).
  const proposal = await ports.propose({
    tripId: state.tripId,
    operationId: state.operationId,
    service,
    offerId,
    sourceFingerprint,
  });
  // Phase 11: choosing a service that already has a confirmed reservation is a
  // replacement, never a second booking. The confirmed row stays active until the
  // replacement decision is explicitly confirmed.
  const progress = await ports.loadProgress(state.tripId);
  const replacing = progress.confirmedServices.includes(service);
  return {
    proposalId: proposal.proposalId,
    selectedOfferId: offerId,
    decisionFingerprint: sourceFingerprint,
    nextDecisionKind: replacing ? "replacement_confirmation" : "booking_confirmation",
    bookingService: service,
  };
}
