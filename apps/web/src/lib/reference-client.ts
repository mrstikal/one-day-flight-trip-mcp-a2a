import { apiGet } from "./api-client";
import { runWithOperationPreloader } from "./operation-preloader";
import { ensureSession } from "./session-client";

/**
 * Reference-search client (country/city/airport). The served datasets never
 * leave the server; the client only holds the returned identifiers/labels.
 */

export interface CountryOption {
  readonly countryKey: string;
  readonly name: string;
  readonly extension: boolean;
}

export interface CityOption {
  readonly id: string;
  readonly name: string;
  readonly asciiName: string;
  readonly coverage: string;
}

export interface AirportOption {
  readonly id: string;
  readonly iata: string;
  readonly name: string;
  readonly municipality?: string;
}

interface ListResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | null;
  readonly datasetLimitation?: string;
}

export async function searchCountries(query: string): Promise<readonly CountryOption[]> {
  return runWithOperationPreloader("Searching countries...", async () => {
    await ensureSession();
    const params = new URLSearchParams({ q: query, limit: "20" });
    const body = await apiGet<ListResponse<CountryOption>>(`/api/reference/countries?${params}`);
    return body.items;
  });
}

export async function searchAirports(query: string): Promise<readonly AirportOption[]> {
  return runWithOperationPreloader("Searching airports...", async () => {
    await ensureSession();
    const params = new URLSearchParams({ q: query, limit: "20" });
    const body = await apiGet<ListResponse<AirportOption>>(`/api/reference/airports?${params}`);
    return body.items;
  });
}

export async function searchCities(
  countryKey: string,
  query: string,
): Promise<{ readonly items: readonly CityOption[]; readonly datasetLimitation?: string }> {
  return runWithOperationPreloader("Loading city data...", async () => {
    await ensureSession();
    const params = new URLSearchParams({ country: countryKey, q: query, limit: "20" });
    const body = await apiGet<ListResponse<CityOption>>(`/api/reference/cities?${params}`);
    return {
      items: body.items,
      ...(body.datasetLimitation ? { datasetLimitation: body.datasetLimitation } : {}),
    };
  });
}
