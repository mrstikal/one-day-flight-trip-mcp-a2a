"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Combobox, type ComboboxOption } from "@/components/Combobox";
import { StepIndicator } from "@/components/trip/StepIndicator";
import { searchAirports } from "@/lib/reference-client";
import { validateWelcomeDraft, type WelcomeErrors } from "@/lib/wizard-form";
import { TripCreatedNotice } from "./TripCreatedNotice";
import { useWizardDraft, type WizardDraft } from "./WizardDraft";

/** Step 0-1/2: welcome, party, origin, date, and provisional preferences. */
export function WelcomeStep(): React.JSX.Element {
  const { draft, update } = useWizardDraft();
  const router = useRouter();
  const tripCreated = draft.tripId !== "";
  const [airportOptions, setAirportOptions] = useState<readonly ComboboxOption[]>([]);
  const [airportsLoading, setAirportsLoading] = useState(false);
  const [errors, setErrors] = useState<WelcomeErrors>({});
  // Monotonic request ids so a slow response cannot overwrite newer results.
  const airportRequest = useRef(0);

  async function onAirportQuery(query: string): Promise<void> {
    const seq = ++airportRequest.current;
    setAirportsLoading(true);
    try {
      const items = await searchAirports(query);
      if (seq !== airportRequest.current) {
        return;
      }
      setAirportOptions(
        items.map((airport) => ({
          id: airport.id,
          label: `${airport.iata} — ${airport.name}`,
          ...(airport.municipality ? { sublabel: airport.municipality } : {}),
        })),
      );
    } catch {
      if (seq === airportRequest.current) {
        setAirportOptions([]);
      }
    } finally {
      if (seq === airportRequest.current) {
        setAirportsLoading(false);
      }
    }
  }

  function onContinue(): void {
    if (tripCreated) {
      return;
    }
    const next = validateWelcomeDraft({
      userName: draft.userName,
      originAirportId: draft.originAirportId,
      sightseeingDate: draft.sightseeingDate,
    });
    setErrors(next);
    if (Object.keys(next).length === 0) {
      router.push("/destination");
    }
  }

  return (
    <form
      className="flex flex-col gap-6"
      aria-labelledby="welcome-heading"
      onSubmit={(event) => {
        event.preventDefault();
        onContinue();
      }}
    >
      <header className="flex flex-col gap-2">
        <StepIndicator step="details" />
        <h1 id="welcome-heading" className="text-2xl">
          Plan one sightseeing day
        </h1>
        <p className="text-sm text-ink-muted">
          A full day on the ground: outbound flight in the morning, return the same evening.
        </p>
      </header>

      {tripCreated ? <TripCreatedNotice /> : null}

      <div className="flex flex-col gap-1">
        <label htmlFor="user-name" className="text-sm font-medium">
          Your name
        </label>
        <input
          id="user-name"
          type="text"
          required
          disabled={tripCreated}
          aria-invalid={errors.userName ? true : undefined}
          aria-describedby={errors.userName ? "user-name-error" : undefined}
          className="rounded border border-border bg-paper px-3 py-2"
          value={draft.userName}
          onChange={(event) => update({ userName: event.target.value })}
        />
        {errors.userName ? (
          <p id="user-name-error" className="text-sm text-clay" role="alert">
            {errors.userName}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="adults" className="text-sm font-medium">
          Adults
        </label>
        <input
          id="adults"
          type="number"
          min={1}
          max={6}
          disabled={tripCreated}
          className="w-24 rounded border border-border bg-paper px-3 py-2"
          value={draft.adults}
          onChange={(event) =>
            update({ adults: Math.max(1, Math.min(6, Number(event.target.value) || 1)) })
          }
        />
      </div>

      <Combobox
        label="Origin airport"
        placeholder="Type a city or airport code"
        options={airportOptions}
        value={
          draft.originAirportId
            ? { id: draft.originAirportId, label: draft.originLabel }
            : null
        }
        loading={airportsLoading}
        disabled={tripCreated}
        onQueryChange={(query) => void onAirportQuery(query)}
        onSelect={(option) => {
          update({ originAirportId: option.id, originLabel: option.label });
          setErrors((previous) => ({ ...previous, origin: "" }));
        }}
      />
      {errors.origin ? (
        <p className="text-sm text-clay" role="alert">
          {errors.origin}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor="sightseeing-date" className="text-sm font-medium">
          Sightseeing date
        </label>
        <input
          id="sightseeing-date"
          type="date"
          required
          disabled={tripCreated}
          aria-invalid={errors.sightseeingDate ? true : undefined}
          className="w-56 rounded border border-border bg-paper px-3 py-2"
          value={draft.sightseeingDate}
          onChange={(event) => update({ sightseeingDate: event.target.value })}
        />
        {errors.sightseeingDate ? (
          <p className="text-sm text-clay" role="alert">
            {errors.sightseeingDate}
          </p>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Trip length</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="travelVariant"
            value="one_night"
            disabled={tripCreated}
            checked={draft.travelVariant === "one_night"}
            onChange={() => update({ travelVariant: "one_night" })}
          />
          One night (long single day)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="travelVariant"
            value="two_nights"
            disabled={tripCreated}
            checked={draft.travelVariant === "two_nights"}
            onChange={() => update({ travelVariant: "two_nights" })}
          />
          Two nights (more relaxed)
        </label>
      </fieldset>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Default service level (provisional)
        <select
          className="w-56 rounded border border-border bg-paper px-3 py-2"
          disabled={tripCreated}
          value={draft.defaultServiceLevel}
          onChange={(event) =>
            update({
              defaultServiceLevel: event.target.value as WizardDraft["defaultServiceLevel"],
            })
          }
        >
          <option value="budget">Budget</option>
          <option value="standard">Standard</option>
          <option value="luxury">Luxury</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Activity pace
        <select
          className="w-56 rounded border border-border bg-paper px-3 py-2"
          disabled={tripCreated}
          value={draft.activityPace}
          onChange={(event) =>
            update({ activityPace: event.target.value as WizardDraft["activityPace"] })
          }
        >
          <option value="relaxed">Relaxed</option>
          <option value="moderate">Moderate</option>
          <option value="intensive">Intensive</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Maximum budget (EUR, optional)
        <input
          type="number"
          min={0}
          disabled={tripCreated}
          className="w-40 rounded border border-border bg-paper px-3 py-2"
          value={draft.maxBudgetEur}
          onChange={(event) => update({ maxBudgetEur: event.target.value })}
        />
      </label>

      <div>
        <button
          type="submit"
          disabled={tripCreated}
          className="rounded bg-teal px-4 py-2 font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
        >
          Continue to destination
        </button>
      </div>
    </form>
  );
}
