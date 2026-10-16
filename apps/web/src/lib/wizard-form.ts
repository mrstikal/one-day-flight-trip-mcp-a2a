import {
  DEFAULT_TRIP_PREFERENCES,
  tripPreferencesSchema,
  uuidSchema,
  type TripPreferences,
} from "@odft/contracts";

/** Pure draft validation/preference helpers shared by the wizard steps (unit-tested). */

export interface WelcomeDraft {
  readonly userName: string;
  readonly originAirportId: string;
  readonly sightseeingDate: string;
}

export interface PreferenceDraft {
  readonly travelVariant: "one_night" | "two_nights";
  readonly defaultServiceLevel: "budget" | "standard" | "luxury";
  readonly activityPace: "relaxed" | "moderate" | "intensive";
  readonly maxBudgetEur: string;
}

/**
 * The browser trip draft spanning the welcome and destination steps. Once
 * `tripId` is set the draft is the created trip's read-only record: the wizard
 * only creates trips, so those steps render it disabled and the completed
 * record is what the provider persists across a page reload.
 */
export interface WizardDraft extends PreferenceDraft {
  readonly userName: string;
  readonly adults: number;
  readonly originAirportId: string;
  readonly originLabel: string;
  readonly sightseeingDate: string;
  readonly countryKey: string;
  readonly countryName: string;
  readonly destinationCityId: string;
  readonly destinationCityLabel: string;
  readonly creationRequestId: string;
  readonly tripId: string;
}

export type WelcomeErrors = Partial<Record<"userName" | "origin" | "sightseeingDate", string>>;

/** Validate the welcome step before advancing. Returns an empty object when valid. */
export function validateWelcomeDraft(draft: WelcomeDraft): WelcomeErrors {
  const errors: WelcomeErrors = {};
  if (!draft.userName.trim()) {
    errors.userName = "Enter your name.";
  }
  if (!draft.originAirportId) {
    errors.origin = "Choose an origin airport.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.sightseeingDate)) {
    errors.sightseeingDate = "Choose a sightseeing date.";
  }
  return errors;
}

/** Build the trip preferences sent at creation; budget is parsed from EUR. */
export function buildPreferences(draft: PreferenceDraft): TripPreferences {
  const preferences: TripPreferences = {
    ...DEFAULT_TRIP_PREFERENCES,
    travelVariant: draft.travelVariant,
    defaultServiceLevel: draft.defaultServiceLevel,
    activityPace: draft.activityPace,
  };
  const budget = Number.parseInt(draft.maxBudgetEur, 10);
  if (Number.isFinite(budget) && budget > 0) {
    preferences.maxBudgetMinor = budget * 100;
  }
  return tripPreferencesSchema.parse(preferences);
}

/** sessionStorage key for the created-trip record (bump when the shape changes). */
export const WIZARD_DRAFT_STORAGE_KEY = "odft.wizard-draft.v1";

/** Serialize the created-trip record for browser storage. */
export function serializeWizardDraft(draft: WizardDraft): string {
  return JSON.stringify(draft);
}

/**
 * Parse a persisted created-trip record. Returns null for anything that is not a
 * complete record of an existing trip (missing `tripId`, malformed JSON, an
 * older or tampered shape), so a stale value can never half-render the read-only
 * wizard and an in-progress draft is never restored.
 */
export function parseWizardDraft(raw: string | null): WizardDraft | null {
  if (raw === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const tripId = uuidSchema.safeParse(record.tripId);
  const creationRequestId = uuidSchema.safeParse(record.creationRequestId);
  if (
    !tripId.success ||
    !creationRequestId.success ||
    typeof record.userName !== "string" ||
    typeof record.adults !== "number" ||
    !Number.isInteger(record.adults) ||
    record.adults < 1 ||
    record.adults > 6 ||
    typeof record.originAirportId !== "string" ||
    typeof record.originLabel !== "string" ||
    typeof record.sightseeingDate !== "string" ||
    (record.travelVariant !== "one_night" && record.travelVariant !== "two_nights") ||
    (record.defaultServiceLevel !== "budget" &&
      record.defaultServiceLevel !== "standard" &&
      record.defaultServiceLevel !== "luxury") ||
    (record.activityPace !== "relaxed" &&
      record.activityPace !== "moderate" &&
      record.activityPace !== "intensive") ||
    typeof record.maxBudgetEur !== "string" ||
    typeof record.countryKey !== "string" ||
    typeof record.countryName !== "string" ||
    typeof record.destinationCityId !== "string" ||
    typeof record.destinationCityLabel !== "string"
  ) {
    return null;
  }
  return {
    userName: record.userName,
    adults: record.adults,
    originAirportId: record.originAirportId,
    originLabel: record.originLabel,
    sightseeingDate: record.sightseeingDate,
    travelVariant: record.travelVariant,
    defaultServiceLevel: record.defaultServiceLevel,
    activityPace: record.activityPace,
    maxBudgetEur: record.maxBudgetEur,
    countryKey: record.countryKey,
    countryName: record.countryName,
    destinationCityId: record.destinationCityId,
    destinationCityLabel: record.destinationCityLabel,
    creationRequestId: creationRequestId.data,
    tripId: tripId.data,
  };
}
