"use client";

import { useState } from "react";
import { Combobox, type ComboboxOption } from "@/components/Combobox";
import { ApiError } from "@/lib/api-client";
import { searchAirports, searchCities, searchCountries, type CityOption } from "@/lib/reference-client";
import { submitCommand } from "@/lib/decision-client";

/**
 * In-place route editor for a rejected route (change origin and/or destination on
 * the SAME trip, via `set_route`). Avoids starting a fresh wizard that would lose
 * the trip's context.
 */
export function RouteFix({
  tripId,
  revision,
  onSubmitted,
}: {
  readonly tripId: string;
  readonly revision: number;
  readonly onSubmitted: () => void;
}): React.JSX.Element {
  const [airportOptions, setAirportOptions] = useState<readonly ComboboxOption[]>([]);
  const [countryOptions, setCountryOptions] = useState<readonly ComboboxOption[]>([]);
  const [cityOptions, setCityOptions] = useState<readonly CityOption[]>([]);
  const [origin, setOrigin] = useState<ComboboxOption | null>(null);
  const [country, setCountry] = useState<{ countryKey: string; name: string } | null>(null);
  const [city, setCity] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onAirportQuery(query: string): Promise<void> {
    setAirportOptions((await searchAirports(query)).map((a) => ({ id: a.id, label: `${a.iata} — ${a.name}` })));
  }

  async function onCountryQuery(query: string): Promise<void> {
    setCountryOptions((await searchCountries(query)).map((c) => ({ id: c.countryKey, label: c.name })));
  }

  async function onCityQuery(query: string): Promise<void> {
    if (!country) {
      return;
    }
    const result = await searchCities(country.countryKey, query);
    setCityOptions(result.items);
  }

  async function submit(): Promise<void> {
    const command: Record<string, unknown> = { type: "set_route" };
    if (origin) {
      command.originAirportId = origin.id;
    }
    if (city) {
      command.destinationCityId = city.id;
    }
    if (!origin && !city) {
      setError("Choose a new origin or destination first.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        command,
      });
      onSubmitted();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the route.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-border bg-cream p-4">
      <p className="text-sm font-medium">Edit this trip route</p>
      <Combobox
        label="New origin airport (optional)"
        placeholder="Type a city or airport code"
        options={airportOptions}
        value={origin}
        onQueryChange={(query) => void onAirportQuery(query)}
        onSelect={setOrigin}
      />
      <Combobox
        label="New destination country (optional)"
        placeholder="Type a country name"
        options={countryOptions}
        value={country ? { id: country.countryKey, label: country.name } : null}
        onQueryChange={(query) => void onCountryQuery(query)}
        onSelect={(option) => {
          setCountry({ countryKey: option.id, name: option.label });
          setCity(null);
          setCityOptions([]);
        }}
      />
      <Combobox
        label="New destination city (optional)"
        placeholder={country ? "Type a city name" : "Choose a country first"}
        options={cityOptions.map((c) => ({ id: c.id, label: c.name }))}
        value={city ? { id: city.id, label: city.label } : null}
        onQueryChange={(query) => void onCityQuery(query)}
        onSelect={(option) => setCity({ id: option.id, label: option.label })}
      />
      {error ? (
        <p role="alert" className="text-sm text-clay">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
      >
        {busy ? "Updating…" : "Update route"}
      </button>
    </div>
  );
}
