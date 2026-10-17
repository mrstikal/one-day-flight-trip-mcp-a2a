import { z } from "zod";
import {
  fingerprintSchema,
  instantSchema,
  nonEmptyStringSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Phase 03: safe protocol observations (plan §3.5, §3.6, §3.9).
 *
 * Every real A2A/MCP interaction persists one sanitized observation with a
 * stable id, source identity, correlation fields and occurrence time. Safe
 * payloads never contain prompts, tokens, credentials or provider stacks; the
 * unique observation-to-application-event link makes SSE ingestion idempotent
 * (Phase 09).
 */

export const protocolSourceSchema = z.enum([
  "coordinator",
  "flight-agent",
  "accommodation-agent",
  "accommodation-alt-agent",
  "city-guide-agent",
  "mcp-geography",
  "mcp-travel-data",
  "mcp-itinerary-tools",
]);
export type ProtocolSource = z.infer<typeof protocolSourceSchema>;

export const protocolObservationKindSchema = z.enum([
  "card_discovery",
  "delegation_dispatched",
  "task_accepted",
  "task_progress",
  "task_input_required",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "artifact_received",
  "artifact_rejected",
  "mcp_connect",
  "mcp_tool_call",
  "mcp_resource_read",
  "outbound_delivery_failed",
  "delegation_revoked",
]);
export type ProtocolObservationKind = z.infer<typeof protocolObservationKindSchema>;

/** Correlation fields shared by every observation (separate ids, no fencing). */
export const protocolCorrelationSchema = z
  .object({
    tripId: uuidSchema.nullable(),
    operationId: uuidSchema.nullable(),
    delegationId: uuidSchema.nullable(),
    /** A2A task/context ids or MCP request id (transport correlation only). */
    taskId: nonEmptyStringSchema.nullable(),
    contextId: nonEmptyStringSchema.nullable(),
    traceId: nonEmptyStringSchema.nullable(),
  })
  .strict();
export type ProtocolCorrelation = z.infer<typeof protocolCorrelationSchema>;

/** Bounded, sanitized payload of one observation. */
export const protocolObservationPayloadSchema = z
  .object({
    /** Safe reason/detail code; never a stack trace or raw response body. */
    detail: z.string().max(400).nullable(),
    /** Safe failure category when the observation reports a failure. */
    failureCategory: nonEmptyStringSchema.nullable(),
    durationMs: z.number().int().min(0).max(3_600_000).nullable(),
    /** SDK-independent status label when applicable. */
    status: nonEmptyStringSchema.nullable(),
    /** Allowlisted scalar counters (e.g. mcpInvocations, attempts). */
    counters: z.record(nonEmptyStringSchema, z.number().int().min(0)).default({}),
  })
  .strict();
export type ProtocolObservationPayload = z.infer<typeof protocolObservationPayloadSchema>;

export const protocolObservationSchema = z
  .object({
    id: uuidSchema,
    source: protocolSourceSchema,
    kind: protocolObservationKindSchema,
    correlation: protocolCorrelationSchema,
    payload: protocolObservationPayloadSchema,
    /** Source time of the observed event (chronology preserved on ingestion). */
    occurredAt: instantSchema,
    /** Canonical hash of the safe payload for dedupe/conflict detection. */
    payloadHash: fingerprintSchema,
  })
  .strict();
export type ProtocolObservation = z.infer<typeof protocolObservationSchema>;

/** Safe DTO exposed to the inspector (Phase 09 renders it; no SDK objects). */
export const publicProtocolObservationSchema = protocolObservationSchema;
export type PublicProtocolObservation = z.infer<typeof publicProtocolObservationSchema>;
