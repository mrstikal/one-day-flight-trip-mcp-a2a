/**
 * Destination-local display formatting. The server sends absolute UTC instants
 * plus IANA zones; the client only formats them for display (it never derives
 * feasibility windows or booking logic).
 */

export function formatTime(instant: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: zone,
  }).format(new Date(instant));
}

export function formatDate(instant: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: zone,
  }).format(new Date(instant));
}

export function formatLocalDate(date: string): string {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) {
    return date;
  }
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) {
    return `${mins}m`;
  }
  return mins === 0 ? `${hours}h` : `${hours}h ${String(mins).padStart(2, "0")}m`;
}

export function formatStops(stops: number): string {
  if (stops === 0) {
    return "Direct";
  }
  return stops === 1 ? "1 stop" : `${stops} stops`;
}
