import type { ProposalStatus, ReservationStatus } from "@odft/contracts";

/**
 * Lifecycle transition tables (09-booking-simulation.md section 4).
 * `proposed` is a `selection_proposals` state, not a reservation state.
 */

export const RESERVATION_TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  confirmed: ["superseded", "cancelled"],
  superseded: [],
  cancelled: [],
};

export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  proposed: ["accepted", "rejected", "expired", "superseded"],
  accepted: [],
  rejected: [],
  expired: [],
  superseded: [],
};

export function canTransitionReservation(from: ReservationStatus, to: ReservationStatus): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

export function canTransitionProposal(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

/** Only a `proposed` proposal can be confirmed or withdrawn. */
export function isProposalActionable(status: ProposalStatus): boolean {
  return status === "proposed";
}

export function isActiveReservation(status: ReservationStatus): boolean {
  return status === "confirmed";
}
