import { isSightseeingDateInWindow } from "@odft/domain";

/**
 * Enforce the allowed sightseeing-date window (today +2 .. today +365) at the BFF
 * request boundary. The domain helper is deterministic; the clock is read here.
 */
export function isValidSightseeingDate(
  sightseeingDate: string,
  now: Date = new Date(),
): boolean {
  const today = now.toISOString().slice(0, 10);
  return isSightseeingDateInWindow(sightseeingDate, today);
}

export const SIGHTSEEING_DATE_WINDOW_MESSAGE =
  "the sightseeing date must be between 2 and 365 days from today";
