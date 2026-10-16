import type { ScenarioDomain, SimulationMode } from "@odft/contracts";

/**
 * Failure-injection overlays (05 section 12, FR-DEMO-2). Overlays change
 * provider/validator behavior only; they never regenerate inventory. Counters
 * are persisted by the caller so injection state survives retries and restarts.
 */

export type FaultDecision = "ok" | "unavailable" | "retryable_error";

export interface BehaviorOverlay {
  readonly mode: SimulationMode;
  /** Which domain the `provider_failure` overlay targets (scenario D). */
  readonly failureDomain: ScenarioDomain | null;
  readonly overlayVersion: number;
  readonly counters: Readonly<Record<string, number>>;
}

export function emptyOverlay(mode: SimulationMode = "normal", overlayVersion = 1): BehaviorOverlay {
  return {
    mode,
    failureDomain: mode === "provider_failure" ? "hotels" : null,
    overlayVersion,
    counters: {},
  };
}

/**
 * Decide the provider result for one attempt. Scenario D (`provider_failure`)
 * fails the first attempt of the injected domain only and succeeds afterwards;
 * `no_flights`/`hotels_unavailable` return a deterministic empty/unavailable
 * set. Re-arming advances `overlayVersion` without changing inventory hashes.
 */
export function decideProviderOutcome(
  overlay: BehaviorOverlay,
  domain: ScenarioDomain,
  attempt: number,
): FaultDecision {
  switch (overlay.mode) {
    case "no_flights":
      return domain === "flights" ? "unavailable" : "ok";
    case "hotels_unavailable":
      return domain === "hotels" ? "unavailable" : "ok";
    case "provider_failure":
      if (overlay.failureDomain === null || domain !== overlay.failureDomain) {
        return "ok";
      }
      return attempt <= 1 ? "retryable_error" : "ok";
    default:
      return "ok";
  }
}

export function recordAttempt(overlay: BehaviorOverlay, key: string): BehaviorOverlay {
  return {
    ...overlay,
    counters: { ...overlay.counters, [key]: (overlay.counters[key] ?? 0) + 1 },
  };
}
