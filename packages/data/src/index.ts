export const PACKAGE_ID = "@odft/data" as const;

export * from "./reference/types.js";
export * from "./reference/country-policy.js";
export * from "./reference/search.js";
export * from "./reference/catchments.js";
export * from "./reference/zones.js";
export * from "./reference/landmarks.js";
export * from "./reference/wikidata-discovery.js";

export * from "./synthetic/seed.js";
export * from "./synthetic/scenario-key.js";
export * from "./synthetic/ids.js";
export * from "./synthetic/anchors.js";
export * from "./synthetic/pricing.js";
export * from "./synthetic/flights.js";
export * from "./synthetic/hotels.js";
export * from "./synthetic/meals.js";
export * from "./synthetic/activities.js";
export * from "./synthetic/events.js";
export * from "./synthetic/snapshot.js";
export * from "./synthetic/faults.js";

export * from "./feasibility/fingerprints.js";
export * from "./feasibility/route-stage-a.js";
export * from "./feasibility/schedule-stage-b.js";
export * from "./feasibility/approval-guard.js";

export * from "./providers/result.js";
export * from "./providers/flight.js";
export * from "./providers/accommodation.js";
export * from "./providers/restaurant.js";
export * from "./providers/attractions.js";
export * from "./providers/events.js";
export * from "./providers/routing.js";
