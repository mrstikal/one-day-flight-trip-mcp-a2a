import { z } from "zod";
import { InvalidUpdateError, ReducedValue } from "@langchain/langgraph";
import {
  RESEARCH_DOMAINS,
  researchDomainSchema,
  researchRunKey,
  researchSearchIntentSchema,
  type ResearchDomain,
} from "@odft/contracts";

/**
 * Phase 09 research fan-out state slice (03 section 4).
 *
 * The production graph extends the Phase 05 harness contract: a keyed
 * `researchResults` reducer channel where a task may write only its own
 * `<researchRunId>:<domain>` key, an equal key may be replaced only with an
 * identical result, and a serial node prunes the map with `Overwrite`. Results
 * are small tagged refs, never datasets.
 */

export { RESEARCH_DOMAINS, researchDomainSchema, researchRunKey, type ResearchDomain };

export const researchDomainStatusSchema = z.enum([
  "ok",
  "unavailable",
  "retryable_error",
  "unsupported",
]);
export type ResearchDomainStatus = z.infer<typeof researchDomainStatusSchema>;

export const researchDomainResultSchema = z
  .object({
    domain: researchDomainSchema,
    status: researchDomainStatusSchema,
    /** The research input fingerprint the result was computed from. */
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /** Persisted recommendation artifact of an `ok` result (null otherwise). */
    artifactId: z.string().uuid().nullable(),
    attempt: z.number().int().min(1).max(2),
    /** True when a persisted simulation overlay produced this outcome. */
    simulatedFailure: z.boolean(),
    reason: z.string().min(1).max(400).nullable(),
    /** Ranked candidate refs of an `ok` result (bounded, never a dataset). */
    offerIds: z.array(z.string().min(1)).max(24),
  })
  .strict();
export type ResearchDomainResult = z.infer<typeof researchDomainResultSchema>;

const researchResultMapSchema = z.record(z.string().min(1), researchDomainResultSchema);

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key];
          return acc;
        }, {});
    }
    return entry;
  });
}

/** Keyed result map default for every consumer (graph state and tests). */
export function emptyResearchResults(): Record<string, ResearchDomainResult> {
  return {};
}

/**
 * Keyed result reducer: unique scope keys merge; an equal key may be replaced
 * only with an identical result; a conflicting same-key result is rejected.
 */
export const researchResultsValue = new ReducedValue(
  researchResultMapSchema.default(emptyResearchResults),
  {
    inputSchema: researchResultMapSchema,
    reducer: (current, next) => {
      const merged: Record<string, ResearchDomainResult> = { ...current };
      for (const [key, value] of Object.entries(next)) {
        const existing = merged[key];
        if (existing === undefined) {
          merged[key] = value;
        } else if (canonical(existing) !== canonical(value)) {
          throw new InvalidUpdateError(
            `conflicting research result for key "${key}" within one reducer scope`,
          );
        }
      }
      return merged;
    },
  },
);

/** Payload handed to a `Send("research_domain", ...)` task. */
export const researchDomainTaskSchema = z
  .object({
    tripId: z.string().min(1),
    operationId: z.string().min(1),
    domain: researchDomainSchema,
    researchRunId: z.string().min(1),
    attempt: z.number().int().min(1).max(2),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /** Phase 11: operation-scoped search intent (level override / cheaper). */
    searchIntent: researchSearchIntentSchema.nullable().optional(),
  })
  .strict();
export type ResearchDomainTask = z.infer<typeof researchDomainTaskSchema>;