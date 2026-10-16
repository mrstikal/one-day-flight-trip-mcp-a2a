import { modelFacingIntentResultSchema } from "@odft/contracts";
import { intentContextSchema } from "../context/compact-context.js";
import { INTENT_PROMPT_VERSION, INTENT_SYSTEM_PROMPT } from "../prompts/intent-v1.js";
import type { RoleDefaultLimits } from "./limits.js";

/** The intent role contract (06-ai-agent-design.md section 5). */
export const intentRole = {
  role: "intent" as const,
  promptVersion: INTENT_PROMPT_VERSION,
  systemPrompt: INTENT_SYSTEM_PROMPT,
  contextSchema: intentContextSchema,
  outputSchema: modelFacingIntentResultSchema,
} as const;

export const INTENT_LIMITS: RoleDefaultLimits = {
  timeoutMs: 20_000,
  maxOutputTokens: 1_024,
  maxAttempts: 2,
  maxInputTokens: 6_000,
  maxCallCostUsd: "0.05",
};
