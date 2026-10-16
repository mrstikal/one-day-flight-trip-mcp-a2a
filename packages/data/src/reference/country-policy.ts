import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Typed access to the committed admission manifest (`data/reference/country-policy.json`).
 *
 * Admission is explicit and manifest-driven; it is never inferred from a source
 * `continent` field. `TR`/`RU` are admitted only through reviewed allowlists.
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, "..", "..", "..", "..");
export const COUNTRY_POLICY_PATH = join(REPO_ROOT, "data", "reference", "country-policy.json");

const centerSchema = z.object({ lat: z.number(), lon: z.number() }).strict();

const policySchema = z
  .object({
    policyVersion: z.string().min(1),
    reviewedOn: z.string().min(1),
    description: z.string().min(1),
    admittedCountryKeys: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
    extensions: z.array(z.object({ countryKey: z.string(), note: z.string().min(1) }).strict()),
    partialAdmission: z.array(
      z
        .object({
          countryKey: z.string().regex(/^[A-Z]{2}$/),
          note: z.string().min(1),
          cityNames: z.array(z.string().min(1)),
          airportIata: z.array(z.string().regex(/^[A-Z]{3}$/)),
        })
        .strict(),
    ),
    islandExceptions: z.array(
      z.object({ name: z.string().min(1), countryKey: z.string().regex(/^[A-Z]{2}$/), note: z.string().min(1) }).strict(),
    ),
    excludedCountryKeys: z.array(z.string().regex(/^[A-Z]{2}$/)),
    curatedCities: z.array(
      z
        .object({
          cityKey: z.string().min(1),
          name: z.string().min(1),
          countryKey: z.string().regex(/^[A-Z]{2}$/),
          center: centerSchema,
          envelopeRadiusKm: z.number().positive(),
        })
        .strict(),
    ),
    curatedDirectPairs: z.array(z.tuple([z.string(), z.string()])),
  })
  .strict();

export type CountryPolicy = z.infer<typeof policySchema>;
export type CuratedCity = CountryPolicy["curatedCities"][number];

let cached: CountryPolicy | undefined;

export function loadCountryPolicy(path: string = COUNTRY_POLICY_PATH): CountryPolicy {
  if (path === COUNTRY_POLICY_PATH && cached) {
    return cached;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const parsed = policySchema.parse(raw);
  if (path === COUNTRY_POLICY_PATH) {
    cached = parsed;
  }
  return parsed;
}

export interface PartialAdmission {
  readonly note: string;
  readonly cityNames: ReadonlySet<string>;
  readonly airportIata: ReadonlySet<string>;
}

export class AdmissionManifest {
  readonly policy: CountryPolicy;
  private readonly admitted = new Set<string>();
  private readonly extensions = new Map<string, string>();
  private readonly partial = new Map<string, PartialAdmission>();

  constructor(policy: CountryPolicy = loadCountryPolicy()) {
    this.policy = policy;
    for (const key of policy.admittedCountryKeys) {
      this.admitted.add(key);
    }
    for (const extension of policy.extensions) {
      this.extensions.set(extension.countryKey, extension.note);
      this.admitted.add(extension.countryKey);
    }
    for (const entry of policy.partialAdmission) {
      this.admitted.add(entry.countryKey);
      this.partial.set(entry.countryKey, {
        note: entry.note,
        cityNames: new Set(entry.cityNames.map((name) => name.toLowerCase())),
        airportIata: new Set(entry.airportIata),
      });
    }
  }

  isAdmittedCountry(countryKey: string): boolean {
    return this.admitted.has(countryKey);
  }

  isPartial(countryKey: string): boolean {
    return this.partial.has(countryKey);
  }

  partialAdmission(countryKey: string): PartialAdmission | undefined {
    return this.partial.get(countryKey);
  }

  /** A city is admitted when its country is admitted and any partial allowlist matches. */
  isAdmittedCity(countryKey: string, name: string): boolean {
    if (!this.admitted.has(countryKey)) {
      return false;
    }
    const partial = this.partial.get(countryKey);
    if (!partial) {
      return true;
    }
    return partial.cityNames.has(name.toLowerCase());
  }

  /** An airport is admitted when its country is admitted and any partial IATA allowlist matches. */
  isAdmittedAirport(countryKey: string, iata: string): boolean {
    if (!this.admitted.has(countryKey)) {
      return false;
    }
    const partial = this.partial.get(countryKey);
    if (!partial) {
      return true;
    }
    return partial.airportIata.has(iata);
  }

  extensionNote(countryKey: string): string | undefined {
    return this.extensions.get(countryKey);
  }

  curatedCityNames(): ReadonlyArray<CuratedCity> {
    return this.policy.curatedCities;
  }
}
