import type { PublicFlightCombination, PublicFlightDirection } from "@odft/contracts";
import { formatDate, formatDuration, formatStops, formatTime } from "@/lib/format/datetime";
import { formatEuroMinor } from "@/lib/format/money";

function DirectionSummary({
  title,
  direction,
  stops,
  minutes,
}: {
  readonly title: string;
  readonly direction: PublicFlightDirection;
  readonly stops: number;
  readonly minutes: number;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        {title} · {formatStops(stops)} · {formatDuration(minutes)}
      </p>
      <ol className="flex flex-col gap-2">
        {direction.segments.map((segment, index) => (
          <li key={`${segment.flightNumber}-${index}`} className="flex flex-col gap-0.5 text-sm">
            <span>
              {formatDate(segment.departureInstant, segment.departureZone)} · {segment.fromIata}{" "}
              {formatTime(segment.departureInstant, segment.departureZone)} → {segment.toIata}{" "}
              {formatTime(segment.arrivalInstant, segment.arrivalZone)}
            </span>
            <span className="text-xs text-ink-muted">
              {segment.airlineName} {segment.flightNumber} · {formatDuration(segment.elapsedMinutes)}{" "}
              · departs {formatTime(segment.departureInstant, "UTC")} UTC
            </span>
            {segment.layoverAfterMinutes > 0 ? (
              <span className="text-xs text-ink-muted">
                Layover {formatDuration(segment.layoverAfterMinutes)} at {segment.toIata}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function FlightCard({
  flight,
  selected,
  onChoose,
  disabled,
  actionLabel,
}: {
  readonly flight: PublicFlightCombination;
  readonly selected: boolean;
  readonly onChoose: () => void;
  readonly disabled: boolean;
  /** Overrides the action label ("Book this flight" for a kept selection). */
  readonly actionLabel?: string;
}): React.JSX.Element {
  return (
    <li
      className={`flex flex-col gap-3 rounded border p-4 ${
        selected ? "border-teal bg-paper" : "border-border bg-paper"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base">Flight combination</h3>
        <p className="text-base font-semibold">
          {formatEuroMinor(flight.partyTotalMinor)}{" "}
          <span className="text-xs font-normal text-ink-muted">
            total for {flight.adults} {flight.adults === 1 ? "adult" : "adults"}
          </span>
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <DirectionSummary
          title="Outbound"
          direction={flight.outbound}
          stops={flight.outboundStops}
          minutes={flight.outboundTravelMinutes}
        />
        <DirectionSummary
          title="Return"
          direction={flight.inbound}
          stops={flight.inboundStops}
          minutes={flight.inboundTravelMinutes}
        />
      </div>
      <p className="text-xs text-ink-muted">
        Total travel time (incl. layovers) {formatDuration(flight.totalTravelMinutes)} ·{" "}
        {formatEuroMinor(flight.perAdultMinor)} per adult ·{" "}
        {flight.supportedVariants.includes("one_night") ? "one-night trip" : "two-night trip"}
      </p>
      <p className="text-xs text-ink-muted">{flight.demoLabels.join(" · ")}</p>
      <div>
        <button
          type="button"
          onClick={onChoose}
          disabled={disabled}
          aria-pressed={selected}
          className="rounded bg-teal px-3 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
        >
          {actionLabel ?? (selected ? "Selected" : "Choose this flight")}
        </button>
      </div>
    </li>
  );
}
