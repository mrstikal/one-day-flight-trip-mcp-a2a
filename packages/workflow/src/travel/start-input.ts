import { chatCommandPayloadSchema, domainCommandSchema } from "@odft/contracts";
import type { InvocationOperation } from "../invocation/choose-invocation.js";

/**
 * Build the plain start input for the production travel graph from a claimed
 * operation. The admitted command payload is forwarded unmodified; the graph's
 * `apply_commands` node re-validates it before mutating the trip. A chat payload
 * is marked `commandType: "chat"` so the graph routes it to `interpret_intent`.
 */
export function buildTravelStartInput(operation: InvocationOperation): Record<string, unknown> {
  const parsed = domainCommandSchema.safeParse(operation.payload);
  const chat = chatCommandPayloadSchema.safeParse(operation.payload);
  return {
    tripId: operation.tripId,
    operationId: operation.id,
    acceptedRevision: operation.acceptedRevision,
    operationKind: operation.kind === "creation" ? "start" : "command",
    commandType: parsed.success ? parsed.data.type : chat.success ? "chat" : null,
    commandPayload: operation.payload ?? null,
  };
}
