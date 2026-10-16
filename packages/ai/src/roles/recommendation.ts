import { z } from "zod";
import { nonEmptyStringSchema } from "@odft/contracts";
import { recommendationContextSchema } from "../context/role-contexts.js";
import {
  RECOMMENDATION_PROMPT_VERSION,
  RECOMMENDATION_SYSTEM_PROMPT,
} from "../prompts/recommendation-v1.js";
import type { RoleDefaultLimits } from "./limits.js";

/** Recommendation role contract (06-ai-agent-design.md section 5). */

export const recommendationOutputSchema = z
  .object({
    rankedOfferIds: z.array(nonEmptyStringSchema).max(20),
    reasons: z
      .array(
        z
          .object({
            offerId: nonEmptyStringSchema,
            explanation: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(20),
    tradeoffs: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict();
export type RecommendationOutput = z.infer<typeof recommendationOutputSchema>;

export const recommendationRole = {
  role: "recommendation" as const,
  promptVersion: RECOMMENDATION_PROMPT_VERSION,
  systemPrompt: RECOMMENDATION_SYSTEM_PROMPT,
  contextSchema: recommendationContextSchema,
  outputSchema: recommendationOutputSchema,
} as const;

export const RECOMMENDATION_LIMITS: RoleDefaultLimits = {
  timeoutMs: 20_000,
  maxOutputTokens: 1_024,
  maxAttempts: 2,
  maxInputTokens: 6_000,
  maxCallCostUsd: "0.05",
};
