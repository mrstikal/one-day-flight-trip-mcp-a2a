export const PACKAGE_ID = "@odft/services" as const;

/**
 * Phase 02: SDK-free composition services shared by the worker (and, in later
 * phases, the coordinator, agents and MCP adapters).
 *
 * This package must never import `@odft/workflow`, LangGraph, A2A or MCP
 * packages: it depends only on the domain contracts, domain/data rules, the
 * governed AI runtime and the persistence layer. The worker graph reaches it
 * through thin compatibility adapters.
 */

export * from "./ai/authority.js";
export * from "./ai/delegated-wiring.js";
export * from "./ai/runtime.js";
export * from "./travel/types.js";
export * from "./travel/context.js";
export * from "./travel/scenario.js";
export * from "./travel/research.js";
export * from "./travel/booking.js";
export * from "./travel/itinerary.js";
export * from "./travel/itinerary-review.js";
export * from "./travel/landmark-discovery.js";
