/**
 * Airport IANA time-zone resolution rules.
 *
 * Zones come only from import-time evidence: `geo-tz` (cross-checked against the
 * nearest GeoNames reference-city zone) plus a reviewed overrides file with
 * reasons. Unknown, ambiguous, or ocean `Etc/GMT` results leave an airport
 * non-selectable as an origin until reviewed.
 */

export const GEO_TZ_VERSION = "8.1.9";

export type ZoneSource = "geo-tz" | "override";

export interface ZoneResolution {
  readonly zone: string;
  readonly zoneSource: ZoneSource;
  readonly zoneEvidence: string;
  readonly zoneOverrideReason?: string;
  readonly ambiguous: boolean;
  readonly ocean: boolean;
  readonly eligibleOrigin: boolean;
}

export interface ZoneOverride {
  readonly zone: string;
  readonly reason: string;
}

/** True for `Etc/*` placeholder zones (ocean or otherwise non-operational). */
export function isPlaceholderZone(zone: string): boolean {
  return zone.startsWith("Etc/");
}

function evidence(
  lat: number,
  lon: number,
  geoZones: readonly string[],
  cityZone: string | undefined,
  chosen: string,
): string {
  return (
    `geo-tz@${GEO_TZ_VERSION} (${lat},${lon}) -> [${geoZones.join(", ") || "none"}]; ` +
    `referenceCityZone=${cityZone ?? "none"}; chosen=${chosen}`
  );
}

/**
 * Resolve an airport's zone from geo-tz candidates and an optional reference-city
 * zone. A reviewed override always wins and is marked as such.
 */
export function resolveZone(
  geoZones: readonly string[],
  lat: number,
  lon: number,
  cityZone: string | undefined,
  override?: ZoneOverride,
): ZoneResolution {
  if (override) {
    return {
      zone: override.zone,
      zoneSource: "override",
      zoneEvidence: `reviewed override: ${override.reason}; geo-tz candidates [${geoZones.join(", ") || "none"}]`,
      zoneOverrideReason: override.reason,
      ambiguous: false,
      ocean: false,
      eligibleOrigin: true,
    };
  }

  const operational = geoZones.filter((zone) => !isPlaceholderZone(zone));
  const ocean = operational.length === 0 && geoZones.length > 0;

  if (operational.length === 0) {
    const chosen = cityZone ?? geoZones[0] ?? "Etc/Unknown";
    return {
      zone: chosen,
      zoneSource: "geo-tz",
      zoneEvidence: evidence(lat, lon, geoZones, cityZone, chosen) + "; unresolved (no operational zone)",
      ambiguous: false,
      ocean,
      eligibleOrigin: false,
    };
  }

  if (operational.length === 1) {
    const chosen = operational[0] as string;
    return {
      zone: chosen,
      zoneSource: "geo-tz",
      zoneEvidence: evidence(lat, lon, geoZones, cityZone, chosen),
      ambiguous: false,
      ocean: false,
      eligibleOrigin: true,
    };
  }

  // Multiple operational candidates: a matching reference-city zone disambiguates.
  if (cityZone && operational.includes(cityZone)) {
    return {
      zone: cityZone,
      zoneSource: "geo-tz",
      zoneEvidence: evidence(lat, lon, geoZones, cityZone, cityZone) + "; cross-checked against reference city",
      ambiguous: false,
      ocean: false,
      eligibleOrigin: true,
    };
  }

  const chosen = cityZone ?? (operational[0] as string);
  return {
    zone: chosen,
    zoneSource: "geo-tz",
    zoneEvidence: evidence(lat, lon, geoZones, cityZone, chosen) + "; ambiguous (multiple operational zones)",
    ambiguous: true,
    ocean: false,
    eligibleOrigin: false,
  };
}
