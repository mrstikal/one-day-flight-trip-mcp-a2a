import { haversineKm, type LatLon } from "../routing/haversine.js";

/**
 * Simulated routing provider (05 section 10). Returns deterministic
 * time/distance/uncertainty and party-total EUR cost, always `simulated: true`,
 * and never a navigable road polyline.
 */

export type RouteMode = "walking" | "public_transport" | "taxi" | "airport_transfer";

export interface RouteEstimateInput {
  readonly startRef: string;
  readonly endRef: string;
  readonly mode: RouteMode;
  readonly adults: number;
  readonly start: LatLon;
  readonly end: LatLon;
  readonly ruleVersion: string;
  /** Reviewed airport-transfer template where available (minutes). */
  readonly transferTemplateMinutes?: number;
}

export interface RouteEstimate {
  readonly startRef: string;
  readonly endRef: string;
  readonly mode: RouteMode;
  readonly adults: number;
  readonly distanceKm: number;
  readonly pathFactor: number;
  readonly estimatedMinutes: number;
  readonly uncertaintyMinutes: number;
  readonly partyTotalMinor: number;
  readonly simulated: true;
  readonly ruleVersion: string;
}

export interface RoutingProvider {
  estimate(input: RouteEstimateInput): RouteEstimate;
}

interface ModeAssumption {
  readonly pathFactor: number;
  readonly speedKmh: number;
  readonly accessMinutes: number;
  readonly uncertaintyMinutes: number;
}

const MODE_ASSUMPTIONS: Record<Exclude<RouteMode, "airport_transfer">, ModeAssumption> = {
  walking: { pathFactor: 1.25, speedKmh: 4.5, accessMinutes: 5, uncertaintyMinutes: 5 },
  public_transport: { pathFactor: 1.35, speedKmh: 18, accessMinutes: 12, uncertaintyMinutes: 5 },
  taxi: { pathFactor: 1.35, speedKmh: 25, accessMinutes: 8, uncertaintyMinutes: 5 },
};

const AIRPORT_TRANSFER_ASSUMPTION: ModeAssumption = {
  pathFactor: 1.35,
  speedKmh: 45,
  accessMinutes: 20,
  uncertaintyMinutes: 20,
};

function transferCostMinor(mode: RouteMode, adults: number, distanceKm: number): number {
  switch (mode) {
    case "walking":
      return 0;
    case "public_transport":
      return 300 * adults;
    case "taxi": {
      const vehicles = Math.ceil(adults / 4);
      return Math.round((5 + 1.2 * distanceKm) * 100) * vehicles;
    }
    case "airport_transfer": {
      const vehicles = Math.ceil(adults / 4);
      const publicTransport = 1_200 * adults;
      const taxi = Math.round((10 + 1.5 * distanceKm) * 100) * vehicles;
      return Math.min(publicTransport, taxi);
    }
  }
}

export class SyntheticRoutingProvider implements RoutingProvider {
  estimate(input: RouteEstimateInput): RouteEstimate {
    const distanceKm = haversineKm(input.start, input.end);
    const assumption =
      input.mode === "airport_transfer"
        ? AIRPORT_TRANSFER_ASSUMPTION
        : MODE_ASSUMPTIONS[input.mode];
    const pathKm = distanceKm * assumption.pathFactor;
    const travelMinutes = (pathKm / assumption.speedKmh) * 60;
    const template =
      input.mode === "airport_transfer" && input.transferTemplateMinutes !== undefined
        ? input.transferTemplateMinutes
        : undefined;
    const estimatedMinutes = Math.max(
      1,
      Math.round(template ?? travelMinutes + assumption.accessMinutes),
    );
    return {
      startRef: input.startRef,
      endRef: input.endRef,
      mode: input.mode,
      adults: input.adults,
      distanceKm: Math.round(distanceKm * 1000) / 1000,
      pathFactor: assumption.pathFactor,
      estimatedMinutes,
      uncertaintyMinutes: assumption.uncertaintyMinutes,
      partyTotalMinor: transferCostMinor(input.mode, input.adults, pathKm),
      simulated: true,
      ruleVersion: input.ruleVersion,
    };
  }
}
