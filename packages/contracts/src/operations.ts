import { z } from "zod";
import { domainCommandSchema } from "./commands.js";
import { operationStatusSchema, travelVariantSchema, workflowStatusSchema } from "./enums.js";
import {
  adultsSchema,
  countryKeySchema,
  fingerprintSchema,
  geographicRefIdSchema,
  localDateSchema,
  messageSchema,
  uuidSchema,
  userNameSchema,
} from "./primitives.js";
import { tripPreferencesSchema } from "./preferences.js";

/** Sessions, trips, operations, and the command-request envelopes. */

export const anonymousSessionSchema = z
  .object({
    id: uuidSchema,
    createdAt: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .strict();
export type AnonymousSession = z.infer<typeof anonymousSessionSchema>;

/** Validated welcome + destination input for trip creation. */
export const creationInputSchema = z
  .object({
    creationRequestId: uuidSchema,
    userName: userNameSchema,
    adults: adultsSchema,
    originAirportId: geographicRefIdSchema,
    destinationCityId: geographicRefIdSchema,
    destinationCountryKey: countryKeySchema,
    sightseeingDate: localDateSchema,
    travelVariant: travelVariantSchema,
    preferences: tripPreferencesSchema.optional(),
  })
  .strict();
export type CreationInput = z.infer<typeof creationInputSchema>;

const expectedRevisionSchema = z.number().int().min(0);

/** A direct graphical control: one strict deterministic domain command. */
export const domainCommandInputSchema = z
  .object({
    requestId: uuidSchema,
    expectedRevision: expectedRevisionSchema,
    command: domainCommandSchema,
  })
  .strict();
export type DomainCommandInput = z.infer<typeof domainCommandInputSchema>;

/** A chat request: a bounded natural-language message interpreted by the intent role. */
export const chatInputSchema = z
  .object({
    requestId: uuidSchema,
    expectedRevision: expectedRevisionSchema,
    chat: messageSchema,
  })
  .strict();
export type ChatInput = z.infer<typeof chatInputSchema>;

export const commandRequestSchema = z.union([domainCommandInputSchema, chatInputSchema]);
export type CommandRequest = z.infer<typeof commandRequestSchema>;

export const operationRecordSchema = z
  .object({
    id: uuidSchema,
    tripId: uuidSchema,
    requestId: uuidSchema,
    payloadHash: fingerprintSchema,
    acceptedRevision: z.number().int().min(0),
    status: operationStatusSchema,
    attempts: z.number().int().min(0),
  })
  .strict();
export type OperationRecord = z.infer<typeof operationRecordSchema>;

export const tripSummarySchema = z
  .object({
    id: uuidSchema,
    sessionId: uuidSchema,
    revision: z.number().int().min(0),
    userName: userNameSchema,
    adults: adultsSchema,
    originAirportId: geographicRefIdSchema,
    destinationCityId: geographicRefIdSchema,
    destinationCountryKey: countryKeySchema,
    sightseeingDate: localDateSchema,
    travelVariant: travelVariantSchema,
    preferences: tripPreferencesSchema,
    workflowStatus: workflowStatusSchema,
    recoveryRequired: z.boolean(),
    /**
     * Failed unfinished operation the owner must recover: present exactly while
     * `recoveryRequired` is set, so the UI retries the operation that owns the
     * unfinished checkpoint (never a newer rejected conflict row).
     */
    recoveryOperationId: uuidSchema.nullable(),
  })
  .strict();
export type TripSummary = z.infer<typeof tripSummarySchema>;

export const admissionAcceptedSchema = z
  .object({
    status: z.literal("accepted"),
    operationId: uuidSchema,
    revision: z.number().int().min(0),
  })
  .strict();
export type AdmissionAccepted = z.infer<typeof admissionAcceptedSchema>;

export const demoReferencePrefixes: Readonly<Record<string, string>> = {
  flights: "DEMO-FLT-",
  hotel: "DEMO-HTL-",
  breakfast: "DEMO-RST-",
  lunch: "DEMO-RST-",
  dinner: "DEMO-RST-",
};
