import { z } from "zod";
import { InvalidUpdateError, ReducedValue, StateSchema } from "@langchain/langgraph";

/**
 * Test-only durable harness state (Phase 05).
 *
 * This schema proves the LangGraph contract (keyed reducer, single interrupt,
 * `Send` fan-out, serial `Overwrite` reset) without any business planner, LLM,
 * or provider call. It intentionally carries only compact references.
 */

export const HARNESS_SCHEMA_VERSION = "harness-state-v1";
export const HARNESS_GRAPH_VERSION = "harness-graph-v0";

export const harnessDomainSchema = z.enum([
  "hotel",
  "breakfast",
  "lunch",
  "dinner",
  "attractions",
  "events",
]);
export type HarnessDomain = z.infer<typeof harnessDomainSchema>;

export const harnessDomainResultSchema = z
  .object({
    domain: harnessDomainSchema,
    status: z.enum(["ok", "unavailable"]),
    fingerprint: z.string().min(1),
    attempts: z.number().int().min(1),
  })
  .strict();
export type HarnessDomainResult = z.infer<typeof harnessDomainResultSchema>;

export const harnessOutcomeSchema = z.enum(["waiting", "success", "noop"]);
export type HarnessOutcome = z.infer<typeof harnessOutcomeSchema>;

const researchResultMapSchema = z.record(z.string(), harnessDomainResultSchema);

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const record = val as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key];
          return acc;
        }, {});
    }
    return val;
  });
}

/**
 * Keyed result reducer. Unique scope keys merge; an equal key may be replaced
 * only with an identical result; a conflicting same-key result is rejected.
 */
export const researchResultsValue = new ReducedValue(
  researchResultMapSchema.default(() => ({})),
  {
    inputSchema: researchResultMapSchema,
    reducer: (current, next) => {
      const merged: Record<string, HarnessDomainResult> = { ...current };
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

/** Full harness state (checkpoint contract). */
export const harnessStateFields = {
  stateSchemaVersion: z.string().default(HARNESS_SCHEMA_VERSION),
  graphVersion: z.string().default(HARNESS_GRAPH_VERSION),
  tripId: z.string().min(1).default(""),
  operationId: z.string().min(1).default(""),
  acceptedRevision: z.number().int().min(0).default(0),
  operationKind: z.enum(["start", "command", "resume"]).default("start"),
  researchRunId: z.string().min(1).default(""),
  requiredDomains: z.array(harnessDomainSchema).default(() => []),
  researchResults: researchResultsValue,
  pendingDecisionRef: z.string().nullable().default(null),
  decisionKind: z.string().nullable().default(null),
  lastOutcome: harnessOutcomeSchema.nullable().default(null),
};

/** The harness StateSchema instance used by the StateGraph. */
export const harnessStateSchema = new StateSchema(harnessStateFields);

/** Plain input accepted when starting a run (never a `Command({ update })`). */
export const harnessStartInputSchema = z
  .object({
    tripId: z.string().min(1),
    operationId: z.string().min(1),
    acceptedRevision: z.number().int().min(0),
    operationKind: z.enum(["start", "command"]),
    requiredDomains: z.array(harnessDomainSchema),
    decisionKind: z.string().min(1).optional(),
  })
  .strict();
export type HarnessStartInput = z.infer<typeof harnessStartInputSchema>;

/** Payload handed to a `Send("research_domain", ...)` task. */
export const researchDomainTaskSchema = z
  .object({
    domain: harnessDomainSchema,
    researchRunId: z.string().min(1),
    operationId: z.string().min(1),
  })
  .strict();
export type ResearchDomainTask = z.infer<typeof researchDomainTaskSchema>;
