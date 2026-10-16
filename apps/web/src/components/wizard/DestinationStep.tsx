"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createTripRequestSchema } from "@odft/contracts";
import { Combobox, type ComboboxOption } from "@/components/Combobox";
import { StepIndicator } from "@/components/trip/StepIndicator";
import { ApiError, apiPost } from "@/lib/api-client";
import { operationPreloader, runWithOperationPreloader } from "@/lib/operation-preloader";
import { searchCities, searchCountries, type CityOption } from "@/lib/reference-client";
import { ensureSession } from "@/lib/session-client";
import { buildPreferences } from "@/lib/wizard-form";
import { TripCreatedNotice } from "./TripCreatedNotice";
import { useWizardDraft } from "./WizardDraft";

/** Steps 1-2: choose the destination country and city, then create the trip. */
export function DestinationStep(): React.JSX.Element {
  const { draft, update } = useWizardDraft();
  const router = useRouter();
  const tripCreated = draft.tripId !== "";
  const [countryOptions, setCountryOptions] = useState<readonly ComboboxOption[]>([]);
  const [cityOptions, setCityOptions] = useState<readonly CityOption[]>([]);
  const [datasetLimitation, setDatasetLimitation] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Monotonic request ids so a slow response cannot overwrite newer results or
  // leak cities from a country the user already changed away from.
  const cityRequest = useRef(0);
  const countryRequest = useRef(0);

  async function onCountryQuery(query: string): Promise<void> {
    const seq = ++countryRequest.current;
    try {
      const items = await searchCountries(query);
      if (seq !== countryRequest.current) {
        return;
      }
      setCountryOptions(
        items.map((country) => ({
          id: country.countryKey,
          label: country.name,
          sublabel: country.countryKey,
        })),
      );
    } catch {
      if (seq === countryRequest.current) {
        setCountryOptions([]);
      }
    }
  }

  async function onCityQuery(query: string): Promise<void> {
    if (!draft.countryKey) {
      return;
    }
    const requestedCountry = draft.countryKey;
    const seq = ++cityRequest.current;
    try {
      const result = await searchCities(requestedCountry, query);
      if (seq !== cityRequest.current || requestedCountry !== draft.countryKey) {
        return;
      }
      setCityOptions(result.items);
      setDatasetLimitation(result.datasetLimitation);
    } catch {
      if (seq === cityRequest.current) {
        setCityOptions([]);
      }
    }
  }

  function preferences(): ReturnType<typeof buildPreferences> {
    return buildPreferences({
      travelVariant: draft.travelVariant,
      defaultServiceLevel: draft.defaultServiceLevel,
      activityPace: draft.activityPace,
      maxBudgetEur: draft.maxBudgetEur,
    });
  }

  async function onCreate(): Promise<void> {
    setError(undefined);
    if (tripCreated) {
      return;
    }
    if (!draft.originAirportId || !draft.countryKey || !draft.destinationCityId) {
      setError("Choose an origin airport, country, and city first.");
      return;
    }
    const creationRequestId = draft.creationRequestId || crypto.randomUUID();
    if (!draft.creationRequestId) {
      update({ creationRequestId });
    }
    const input = {
      creationRequestId,
      userName: draft.userName,
      adults: draft.adults,
      originAirportId: draft.originAirportId,
      destinationCityId: draft.destinationCityId,
      destinationCountryKey: draft.countryKey,
      sightseeingDate: draft.sightseeingDate,
      travelVariant: draft.travelVariant,
      preferences: preferences(),
    };
    const parsed = createTripRequestSchema.safeParse(input);
    if (!parsed.success) {
      setError("Some trip details are missing or invalid.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await runWithOperationPreloader("Creating your plan...", async () => {
        const csrfToken = await ensureSession();
        return apiPost<{ tripId: string; operationId: string }>(
          "/api/trips",
          parsed.data,
          { "x-csrf-token": csrfToken },
        );
      });
      operationPreloader.trackAcceptedOperation(created.operationId, "Creating your plan...");
      update({ creationRequestId, tripId: created.tripId });
      router.push(`/trips/${created.tripId}/flights`);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not create the trip. Try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="destination-heading">
      <header className="flex flex-col gap-2">
        <StepIndicator step="destination" />
        <h1 id="destination-heading" className="text-2xl">
          Choose your destination
        </h1>
        <p className="text-sm text-ink-muted">
          The trip is created only after you pick a city — never before.
        </p>
      </header>

      {tripCreated ? <TripCreatedNotice /> : null}

      <Combobox
        label="Country"
        placeholder="Type a country name"
        options={countryOptions}
        value={draft.countryKey ? { id: draft.countryKey, label: draft.countryName } : null}
        disabled={tripCreated}
        onQueryChange={(query) => void onCountryQuery(query)}
        onSelect={(option) => {
          cityRequest.current += 1;
          update({
            countryKey: option.id,
            countryName: option.label,
            destinationCityId: "",
            destinationCityLabel: "",
          });
          setCityOptions([]);
        }}
      />

      <Combobox
        label="City"
        placeholder={draft.countryKey ? "Type a city name" : "Choose a country first"}
        options={cityOptions.map((city) => ({
          id: city.id,
          label: city.name,
          ...(city.asciiName && city.asciiName !== city.name ? { sublabel: city.asciiName } : {}),
        }))}
        value={
          draft.destinationCityId
            ? { id: draft.destinationCityId, label: draft.destinationCityLabel }
            : null
        }
        disabled={tripCreated}
        onQueryChange={(query) => void onCityQuery(query)}
        onSelect={(option) => {
          update({
            destinationCityId: option.id,
            destinationCityLabel: option.label,
          });
        }}
      />
      {datasetLimitation ? (
        <p className="text-sm text-clay" role="note">
          {datasetLimitation}
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-ink-muted">Traveller</dt>
        <dd>{draft.userName || "—"}</dd>
        <dt className="text-ink-muted">Adults</dt>
        <dd>{draft.adults}</dd>
        <dt className="text-ink-muted">Origin</dt>
        <dd>{draft.originLabel || "—"}</dd>
        <dt className="text-ink-muted">Date</dt>
        <dd>{draft.sightseeingDate || "—"}</dd>
        <dt className="text-ink-muted">Trip length</dt>
        <dd>{draft.travelVariant === "one_night" ? "One night" : "Two nights"}</dd>
      </dl>

      {error ? (
        <p className="text-sm text-clay" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-4">
        <Link href="/" className="text-sm underline">
          Back
        </Link>
        <button
          type="button"
          onClick={() => void onCreate()}
          disabled={submitting || tripCreated}
          className="rounded bg-teal px-4 py-2 font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create trip"}
        </button>
      </div>
    </section>
  );
}
