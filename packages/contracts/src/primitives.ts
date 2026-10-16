import { z } from "zod";

/**
 * Shared primitive schemas (04-domain-model.md section 1). All objects that use
 * these are strict and reject unknown keys at executable boundaries.
 */

export const uuidSchema = z.string().uuid();

export const ID_PATTERNS = {
  geonames: /^geonames:\d+$/,
  ourairports: /^ourairports:\d+$/,
  wikidata: /^wikidata:Q\d+$/,
} as const;

export const geographicRefIdSchema = z
  .string()
  .regex(/^(geonames:\d+|ourairports:\d+|wikidata:Q\d+)$/);

export const airportCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export const countryKeySchema = z.string().regex(/^[A-Z]{2}$/);
export const iataCodeSchema = airportCodeSchema;

export const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function isCalendarDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** ISO `YYYY-MM-DD` parsed as a real calendar date, not only regex-checked. */
export const localDateSchema = z
  .string()
  .refine(isCalendarDate, "must be a valid ISO YYYY-MM-DD calendar date");

/** ISO UTC instant ending in `Z` — no local offsets. */
export const instantSchema = z
  .string()
  .regex(INSTANT_PATTERN, "must be an ISO UTC instant ending in Z");

function isIanaZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z.string().min(1).refine(isIanaZone, "must be a known IANA time zone");

/** Integer EUR minor units, nonnegative and bounded. */
export const moneyMinorSchema = z.number().int().min(0).max(100_000_000);

export const coordinatesSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    precisionMeters: z.number().nonnegative().optional(),
  })
  .strict();

export const nonEmptyStringSchema = z.string().min(1);
export const userNameSchema = z.string().trim().min(1).max(60);
export const adultsSchema = z.number().int().min(1).max(6);
export const messageSchema = z.string().trim().min(1).max(2000);
