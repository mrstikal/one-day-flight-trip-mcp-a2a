import { z } from "zod";
import { nonEmptyStringSchema } from "@odft/contracts";
import { reviewerContextSchema } from "../context/role-contexts.js";
import { REVIEWER_PROMPT_VERSION, REVIEWER_SYSTEM_PROMPT } from "../prompts/reviewer-v2.js";
import type { RoleDefaultLimits } from "./limits.js";

/** Reviewer role contract (06-ai-agent-design.md section 5). */

export const reviewIssueCodeSchema = z.enum([
  "poor_sequence",
  "excess_travel",
  "pace_mismatch",
  "interest_mismatch",
  "insufficient_variety",
  "unexplained_compromise",
]);
export type ReviewIssueCode = z.infer<typeof reviewIssueCodeSchema>;

export const reviewerOutputSchema = z
  .object({
    verdict: z.enum(["acceptable", "revise", "conflict"]),
    issues: z
      .array(
        z
          .object({
            code: reviewIssueCodeSchema,
            eventIds: z.array(nonEmptyStringSchema).max(8),
            explanation: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(8),
    suggestedOrder: z.array(nonEmptyStringSchema).max(24),
    explanation: z.string().min(1).max(1000),
  })
  .strict();
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

export const reviewerRole = {
  role: "reviewer" as const,
  promptVersion: REVIEWER_PROMPT_VERSION,
  systemPrompt: REVIEWER_SYSTEM_PROMPT,
  contextSchema: reviewerContextSchema,
  outputSchema: reviewerOutputSchema,
} as const;

export const REVIEWER_LIMITS: RoleDefaultLimits = {
  timeoutMs: 20_000,
  // Reasoning-capable models count hidden reasoning tokens toward maxOutputTokens
  // (2026-10-15: reviews of a revised draft hit the old 1024 cap and failed the
  // planning loop), so the reviewer gets the planner-sized headroom.
  maxOutputTokens: 2_048,
  maxAttempts: 2,
  maxInputTokens: 6_000,
  maxCallCostUsd: "0.05",
};
