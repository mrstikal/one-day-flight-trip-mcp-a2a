import { intentRole } from "./intent.js";
import { plannerRole } from "./planner.js";
import { recommendationRole } from "./recommendation.js";
import { reviewerRole } from "./reviewer.js";

/** The single role registry: one place pairing a role with its context/output schemas. */

export const ROLE_CONTRACTS = {
  intent: intentRole,
  recommendation: recommendationRole,
  planner: plannerRole,
  reviewer: reviewerRole,
} as const;

export const ROLE_CONTEXT_SCHEMAS = {
  intent: intentRole.contextSchema,
  recommendation: recommendationRole.contextSchema,
  planner: plannerRole.contextSchema,
  reviewer: reviewerRole.contextSchema,
} as const;
