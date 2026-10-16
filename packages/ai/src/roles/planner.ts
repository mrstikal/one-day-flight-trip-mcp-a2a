import { z } from "zod";
import { nonEmptyStringSchema } from "@odft/contracts";
import { plannerContextSchema } from "../context/role-contexts.js";
import { PLANNER_PROMPT_VERSION, PLANNER_SYSTEM_PROMPT } from "../prompts/planner-v2.js";
import type { RoleDefaultLimits } from "./limits.js";

/** Planner role contract (06-ai-agent-design.md section 5). */

const stopBase = {
  startMinute: z.number().int().min(0).max(1439),
  durationMinutes: z.number().int().min(5).max(180),
};

const proposedStopSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("meal"), refId: nonEmptyStringSchema, ...stopBase }).strict(),
  z.object({ kind: z.literal("activity"), refId: nonEmptyStringSchema, ...stopBase }).strict(),
  z.object({ kind: z.literal("break"), ...stopBase }).strict(),
  z.object({ kind: z.literal("free_time"), ...stopBase }).strict(),
]);
export type ProposedStop = z.infer<typeof proposedStopSchema>;

export const plannerOutputSchema = z
  .object({
    stops: z.array(proposedStopSchema).max(24),
    explanation: z.string().min(1).max(1000),
    compromises: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict();
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export const plannerRole = {
  role: "planner" as const,
  promptVersion: PLANNER_PROMPT_VERSION,
  systemPrompt: PLANNER_SYSTEM_PROMPT,
  contextSchema: plannerContextSchema,
  outputSchema: plannerOutputSchema,
} as const;

export const PLANNER_LIMITS: RoleDefaultLimits = {
  timeoutMs: 30_000,
  // Triple the previous 2048 cap (2026-10-15): revision drafts carry more context
  // and reasoning, and the output cap must never truncate a valid plan.
  maxOutputTokens: 6_144,
  maxAttempts: 2,
  maxInputTokens: 6_000,
  maxCallCostUsd: "0.20",
};
