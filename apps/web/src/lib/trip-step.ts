/**
 * The trip's current step: the step that needs the user next, mirroring the
 * forward links of the individual steps. Shared by the summary CTA, the
 * itinerary empty state, the assistant rail, and the inspector's "Back to the
 * trip" link so the step order can never drift between them.
 *
 * A pending decision wins over progress: while the worker waits for a
 * `hotel_choice` (even for a replacement of a confirmed hotel) the current step
 * is the page that presents it, not the next unfinished milestone.
 */

export interface TripStep {
  readonly href: string;
  /** Call to action for a "continue" button on the current page. */
  readonly cta: string;
  /** Label for pointing at the step from elsewhere (the assistant rail). */
  readonly open: string;
}

export interface TripStepInput {
  readonly tripId: string;
  readonly reservations: readonly { readonly serviceKey: string; readonly status: string }[];
  readonly hasProgram: boolean;
  readonly hasItinerary: boolean;
  /**
   * Phase 12: the flight/hotel was kept as a selection when its booking was
   * declined ("I don't want to book"), so the step counts as settled without a
   * reservation.
   */
  readonly flightSelected?: boolean;
  readonly hotelSelected?: boolean;
  /** Kind of the pending decision, when one is waiting for the user. */
  readonly pendingDecisionKind?: string | null;
  /** Service of the staged proposal, for booking/replacement confirmations. */
  readonly proposalServiceKey?: string | null;
}

function step(
  kind: "flights" | "hotel" | "meals" | "activities" | "itinerary",
  input: TripStepInput,
  confirmed: ReadonlySet<string>,
): TripStep {
  switch (kind) {
    case "flights":
      return {
        href: `/trips/${input.tripId}/flights`,
        cta: confirmed.has("flights") ? "Choose a different flight" : "Go to flight selection",
        open: "Open flight selection",
      };
    case "hotel":
      return {
        href: `/trips/${input.tripId}/hotel`,
        cta: confirmed.has("hotel") ? "Choose a different hotel" : "Continue to hotel selection",
        open: "Open hotel selection",
      };
    case "meals":
      return { href: `/trips/${input.tripId}/meals`, cta: "Continue to meals", open: "Open meals" };
    case "activities":
      return {
        href: `/trips/${input.tripId}/activities`,
        cta: "Go to activities",
        open: "Open activities",
      };
    case "itinerary":
      return {
        href: `/trips/${input.tripId}/itinerary`,
        cta: "Open the itinerary",
        open: "Open the itinerary",
      };
  }
}

/**
 * A saved program: the projection always contains a program block as soon as the
 * snapshot materializes meals and activities, so only the persisted meal
 * selections (trip_selections) prove the user applied the program step. A
 * breakfast the traveler arranges themselves ("I'll arrange it myself") is also
 * part of a saved program — its selection is intentionally absent.
 */
export function hasSavedProgram(
  program: {
    readonly selectedMeals: { readonly breakfast: string | null };
    readonly selfArrangedMeals?: {
      readonly breakfast: boolean;
      readonly lunch: boolean;
      readonly dinner: boolean;
    };
  } | null,
): boolean {
  return (
    program !== null &&
    (program.selectedMeals.breakfast !== null ||
      program.selfArrangedMeals?.breakfast === true)
  );
}

export type TripStepKey =
  | "details"
  | "destination"
  | "flights"
  | "hotel"
  | "meals"
  | "activities"
  | "itinerary"
  | "summary";

/**
 * The canonical order of the trip's screens. The sticky step navigation renders
 * the steps in this order and every screen header derives its `Step N of M`
 * indicator from it, so the two can never drift apart.
 */
const TRIP_STEP_SEQUENCE: readonly TripStepKey[] = [
  "details",
  "destination",
  "flights",
  "hotel",
  "meals",
  "activities",
  "itinerary",
  "summary",
];

/** The `Step N of M` indicator shown in a screen header. */
export function tripStepHeading(key: TripStepKey): string {
  return `Step ${TRIP_STEP_SEQUENCE.indexOf(key) + 1} of ${TRIP_STEP_SEQUENCE.length}`;
}

export interface TripStepEntry {
  readonly key: TripStepKey;
  readonly label: string;
  readonly href: string;
  readonly enabled: boolean;
  /** Why the step is not available yet (hint for the disabled state). */
  readonly requires: string | null;
  /** True for the step that needs the user next (decision-aware). */
  readonly next: boolean;
}

/**
 * The trip's step list for the sticky step navigation. A step is enabled once
 * its prerequisite milestone is done (a confirmed flight unlocks the hotel, a
 * confirmed hotel unlocks the meals, a saved program unlocks the activities and
 * the itinerary); the wizard's first two screens stay reachable because they
 * render the created trip read-only. The decision-aware `nextTripStep` marks the
 * step that needs the user next.
 */
export function tripStepStates(input: TripStepInput): readonly TripStepEntry[] {
  const confirmed = new Set(
    input.reservations
      .filter((reservation) => reservation.status === "confirmed")
      .map((reservation) => reservation.serviceKey),
  );
  const flights = confirmed.has("flights");
  const hotel = confirmed.has("hotel");
  const flightsSettled = flights || input.flightSelected === true;
  const hotelSettled = hotel || input.hotelSelected === true;
  const nextHref = nextTripStep(input)?.href ?? null;
  const steps: Omit<TripStepEntry, "next">[] = [
    { key: "details", label: "Trip details", href: "/", enabled: true, requires: null },
    {
      key: "destination",
      label: "Destination",
      href: "/destination",
      enabled: true,
      requires: null,
    },
    {
      key: "flights",
      label: "Flights",
      href: `/trips/${input.tripId}/flights`,
      enabled: true,
      requires: null,
    },
    {
      key: "hotel",
      label: "Hotel",
      href: `/trips/${input.tripId}/hotel`,
      enabled: flightsSettled,
      requires: flightsSettled ? null : "Confirm a flight (or arrange it yourself) first",
    },
    {
      key: "meals",
      label: "Meals",
      href: `/trips/${input.tripId}/meals`,
      enabled: hotelSettled,
      requires: hotelSettled ? null : "Confirm a hotel (or arrange it yourself) first",
    },
    {
      key: "activities",
      label: "Activities",
      href: `/trips/${input.tripId}/activities`,
      enabled: input.hasProgram,
      requires: input.hasProgram ? null : "Save the meal program first",
    },
    {
      key: "itinerary",
      label: "Itinerary",
      href: `/trips/${input.tripId}/itinerary`,
      enabled: input.hasProgram,
      requires: input.hasProgram ? null : "Save the meal program first",
    },
    {
      key: "summary",
      label: "Summary",
      href: `/trips/${input.tripId}/summary`,
      enabled: true,
      requires: null,
    },
  ];
  return steps.map((step) => ({ ...step, next: step.href === nextHref }));
}

/**
 * The trip page a recovery option reopens (null: stay on the current page).
 * `change_hotel`/`change_meals` reopen that step's decision; a `change_program`
 * research failure ends the run on the affected page, so the user stays there.
 */
export function recoveryOptionHref(tripId: string, optionId: string): string | null {
  switch (optionId) {
    case "change_hotel":
      return `/trips/${tripId}/hotel`;
    case "change_meals":
      return `/trips/${tripId}/meals`;
    default:
      return null;
  }
}

/** Returns null once the itinerary exists and no decision is pending. */
export function nextTripStep(input: TripStepInput): TripStep | null {
  const confirmed = new Set(
    input.reservations
      .filter((reservation) => reservation.status === "confirmed")
      .map((reservation) => reservation.serviceKey),
  );

  switch (input.pendingDecisionKind) {
    case "flight_choice":
      return step("flights", input, confirmed);
    case "hotel_choice":
      return step("hotel", input, confirmed);
    case "program_choices":
      return step("meals", input, confirmed);
    case "itinerary_approval":
      return step("itinerary", input, confirmed);
    case "route_change_confirmation":
      // The impact card lives in the assistant rail; confirming it restarts
      // feasibility and yields a fresh flight choice.
      return step("flights", input, confirmed);
    case "booking_confirmation":
    case "replacement_confirmation": {
      const service = input.proposalServiceKey;
      if (service === "flights" || service === "hotel") {
        return step(service, input, confirmed);
      }
      if (service === "breakfast" || service === "lunch" || service === "dinner") {
        return step("meals", input, confirmed);
      }
      break;
    }
    default:
      break;
  }

  if (!confirmed.has("flights") && input.flightSelected !== true) {
    return step("flights", input, confirmed);
  }
  if (!confirmed.has("hotel") && input.hotelSelected !== true) {
    return step("hotel", input, confirmed);
  }
  if (!input.hasProgram) {
    return step("meals", input, confirmed);
  }
  if (!input.hasItinerary) {
    return step("activities", input, confirmed);
  }
  return null;
}