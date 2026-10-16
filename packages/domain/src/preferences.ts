import type { ServiceKey, ServiceLevel, TripPreferences } from "@odft/contracts";

/** Deterministic preference helpers (04-domain-model.md section 2 / FR-PREF-3). */

/**
 * Effective service level is `override ?? default`. An explicit `standard`
 * override counts as an override; clearing it (removing the key) restores the
 * inherited default. A global default change therefore touches only services
 * that inherit it.
 */
export function resolveEffectiveLevel(
  preferences: Pick<TripPreferences, "defaultServiceLevel" | "serviceOverrides">,
  service: ServiceKey,
): ServiceLevel {
  return preferences.serviceOverrides[service] ?? preferences.defaultServiceLevel;
}

export function hasOverride(
  preferences: Pick<TripPreferences, "serviceOverrides">,
  service: ServiceKey,
): boolean {
  return preferences.serviceOverrides[service] !== undefined;
}
