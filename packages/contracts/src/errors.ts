import { z } from "zod";
import { uuidSchema } from "./primitives.js";

/** Safe error envelope (02-architecture.md section 8 / 10-security section 9). */

export const errorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CREATION_CONFLICT",
  "STALE_REVISION",
  "OPERATION_IN_PROGRESS",
  "RECOVERY_REQUIRED",
  "STALE_DECISION",
  "STALE_ROUTE_APPROVAL",
  "PROPOSAL_EXPIRED",
  "OFFER_UNAVAILABLE",
  "OFFER_MISMATCH",
  "DISCLAIMER_REQUIRED",
  "REPLACEMENT_CONFIRMATION_REQUIRED",
  "REF_GENERATION_FAILED",
  "ITINERARY_NOT_APPROVABLE",
  "STALE_ITINERARY",
  "RATE_LIMITED",
  "VOICE_DISABLED",
  "VOICE_NOT_CONFIGURED",
  "VOICE_CAPABILITY_UNKNOWN",
  "VOICE_INPUT_TOO_LARGE",
  "VOICE_UNSUPPORTED_AUDIO",
  "VOICE_NO_SPEECH",
  "VOICE_TRANSCRIPT_TOO_LONG",
  "VOICE_MESSAGE_NOT_READY",
  "VOICE_REQUEST_IN_PROGRESS",
  "VOICE_RESULT_EXPIRED",
  "VOICE_BUDGET_EXCEEDED",
  "VOICE_UPSTREAM_FAILED",
  "VOICE_TIMEOUT",
  "CONFLICT",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorEnvelopeSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    currentRevision: z.number().int().min(0).optional(),
    operationId: uuidSchema.optional(),
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
