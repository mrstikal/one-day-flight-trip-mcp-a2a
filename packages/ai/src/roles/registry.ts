import { z } from "zod";
import { intentRole } from "./intent.js";
import { plannerRole } from "./planner.js";
import { flightRecommendationRole, recommendationRole } from "./recommendation.js";
import { reviewerRole } from "./reviewer.js";

/** The single role registry: one place pairing a role with its context/output schemas. */

export const ROLE_CONTRACTS = {
  intent: intentRole,
  recommendation: recommendationRole,
  planner: plannerRole,
  reviewer: reviewerRole,
} as const;

// The recommendation role serves two prompt versions with different context
// shapes: the v1 hotel/meal/activity ranking and the Phase 05 flight ranking.
// `assertRoleContext` must accept either, matching `RoleContextMap`.
const recommendationContextSchema = z.union([
  recommendationRole.contextSchema,
  flightRecommendationRole.contextSchema,
]);

export const ROLE_CONTEXT_SCHEMAS = {
  intent: intentRole.contextSchema,
  recommendation: recommendationContextSchema,
  planner: plannerRole.contextSchema,
  reviewer: reviewerRole.contextSchema,
} as const;
