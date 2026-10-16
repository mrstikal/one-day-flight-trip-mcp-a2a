import { Temporal } from "@js-temporal/polyfill";
import type { TravelVariant } from "@odft/contracts";

/**
 * Destination-local trip date math (04-domain-model.md section 2 / FR-PREF-2).
 * Uses Temporal calendar arithmetic, never server-local `Date` arithmetic.
 * `D` is the destination-local sightseeing date.
 */

export const SIGHTSEEING_WINDOW_MIN_DAYS = 2;
export const SIGHTSEEING_WINDOW_MAX_DAYS = 365;

export function nightsForVariant(variant: TravelVariant): 1 | 2 {
  return variant === "one_night" ? 1 : 2;
}

function date(value: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(value);
}

/** Outbound arrival is destination-local `D-1`. */
export function outboundArrivalDate(sightseeingDate: string): string {
  return date(sightseeingDate).subtract({ days: 1 }).toString();
}

/** Hotel check-in is destination-local `D-1`. */
export function checkInDate(sightseeingDate: string): string {
  return date(sightseeingDate).subtract({ days: 1 }).toString();
}

/** Hotel checkout is `D` for one night or `D+1` for two nights. */
export function checkOutDate(sightseeingDate: string, variant: TravelVariant): string {
  return date(sightseeingDate).add({ days: nightsForVariant(variant) - 1 }).toString();
}

/** Return departure is late on `D` (one night) or `D+1` (two nights). */
export function returnDepartureDate(sightseeingDate: string, variant: TravelVariant): string {
  return checkOutDate(sightseeingDate, variant);
}

export interface SightseeingDateWindow {
  readonly minDaysAhead?: number;
  readonly maxDaysAhead?: number;
}

/**
 * Whether a sightseeing date is within the allowed window relative to an
 * injected clock's local date. Default window is today+2 .. today+365.
 */
export function isSightseeingDateInWindow(
  sightseeingDate: string,
  today: string | Temporal.PlainDateLike,
  window: SightseeingDateWindow = {},
): boolean {
  const minDays = window.minDaysAhead ?? SIGHTSEEING_WINDOW_MIN_DAYS;
  const maxDays = window.maxDaysAhead ?? SIGHTSEEING_WINDOW_MAX_DAYS;
  const todayDate = Temporal.PlainDate.from(today);
  const target = date(sightseeingDate);
  const delta = todayDate.until(target).days;
  return delta >= minDays && delta <= maxDays;
}
