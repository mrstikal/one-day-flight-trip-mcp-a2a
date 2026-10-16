import {
  chatCommandPayloadSchema,
  DECISION_ALLOWED_ACTIONS,
  decisionKindSchema,
  domainCommandSchema,
  graphResumeEnvelopeSchema,
  resumeRequestSchema,
  type DecisionKind,
  type GraphResumeEnvelope,
} from "@odft/contracts";
import { harnessDomainSchema, type HarnessDomain } from "../harness/state.js";

/**
 * Invocation selection (03-langgraph-design.md section 8).
 *
 * Given the current checkpoint snapshot and the admitted operation, choose the
 * exact invocation. This is a pure function: it never touches the database and
 * never invents a resume answer.
 */

export type InvocationOperationKind = "command" | "creation" | "decision";

export interface InvocationOperation {
  readonly id: string;
  readonly tripId: string;
  readonly kind: InvocationOperationKind;
  readonly acceptedRevision: number;
  readonly payload: unknown;
}

/** The compact slice of `StateSnapshot` this decision needs. */
export interface CheckpointView {
  readonly values: Record<string, unknown>;
  readonly next: readonly string[];
  readonly interrupts: readonly { readonly id: string; readonly value: unknown }[];
  /** LangGraph checkpoint id of this snapshot (inspector evidence). */
  readonly checkpointId?: string | null;
}

export type InvocationChoice =
  | { readonly kind: "start"; readonly input: Record<string, unknown> }
  | { readonly kind: "resume"; readonly envelope: GraphResumeEnvelope }
  | { readonly kind: "recover"; readonly input: null }
  | { readonly kind: "reconcile" }
  | { readonly kind: "waiting"; readonly reason: string }
  | { readonly kind: "conflict"; readonly message: string };

export interface ChooseInvocationOptions {
  /** The decision id of the trip's current pending decision, if any. */
  readonly pendingDecisionId?: string;
  /** The kind of the trip's current pending decision, if any. */
  readonly pendingDecisionKind?: DecisionKind;
  /**
   * Graph-specific plain start-input builder (never a resume). Defaults to the
   * Phase 05 harness shape; the production travel graph injects its own.
   */
  readonly buildStartInput?: (operation: InvocationOperation) => Record<string, unknown>;
}

const DEFAULT_HARNESS_DOMAINS: HarnessDomain[] = ["hotel", "dinner", "attractions"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildHarnessStartInput(operation: InvocationOperation): Record<string, unknown> {
  const payload = asRecord(operation.payload);
  const requested = Array.isArray(payload.requiredDomains) ? payload.requiredDomains : undefined;
  const parsed = requested
    ? requested.filter((domain): domain is HarnessDomain => harnessDomainSchema.safeParse(domain).success)
    : DEFAULT_HARNESS_DOMAINS;
  return {
    tripId: operation.tripId,
    operationId: operation.id,
    acceptedRevision: operation.acceptedRevision,
    operationKind: operation.kind === "creation" ? "start" : "command",
    requiredDomains: parsed,
    decisionKind: typeof payload.decisionKind === "string" ? payload.decisionKind : "clarification",
  };
}

function buildEnvelope(operation: InvocationOperation): GraphResumeEnvelope | undefined {
  const parsed = resumeRequestSchema.safeParse(operation.payload);
  if (!parsed.success) {
    return undefined;
  }
  return graphResumeEnvelopeSchema.parse({
    operationId: operation.id,
    acceptedRevision: operation.acceptedRevision,
    decisionId: parsed.data.decisionId,
    response: parsed.data.response,
  });
}

function hasPersistedState(state: CheckpointView | null): boolean {
  if (!state) {
    return false;
  }
  return typeof state.values.tripId === "string" && state.values.tripId.length > 0;
}

export function chooseInvocation(
  state: CheckpointView | null,
  operation: InvocationOperation,
  options: ChooseInvocationOptions = {},
): InvocationChoice {
  const buildStartInput = options.buildStartInput ?? buildHarnessStartInput;
  // No checkpoint (new thread, or crash before the first invoke): run the
  // original persisted input exactly once under the same operation effect keys.
  if (!hasPersistedState(state) || state === null) {
    if (operation.kind === "decision") {
      return { kind: "conflict", message: "no matching interrupt for this resume" };
    }
    return { kind: "start", input: buildStartInput(operation) };
  }

  if (state.interrupts.length > 0) {
    // A decision operation resumes the exact interrupt with the trusted envelope;
    // the driver separately checks it against the current pending decision.
    if (operation.kind === "decision") {
      const envelope = buildEnvelope(operation);
      if (!envelope) {
        return { kind: "conflict", message: "decision payload is not a valid resume request" };
      }
      if (options.pendingDecisionId && envelope.decisionId !== options.pendingDecisionId) {
        return { kind: "conflict", message: "resume does not match the current pending decision" };
      }
      // A single run may hold two sequential interrupts (e.g. flight_choice then
      // booking_confirmation). Until the driver commits the new wait, the DB may
      // still hold the previous decision, so replaying the stored envelope
      // against the *current* interrupt must be refused when its action cannot
      // answer that kind — restore the waiting projection instead.
      const currentKind = decisionKindSchema.safeParse(
        (state.interrupts[0]?.value as { kind?: unknown } | undefined)?.kind,
      );
      if (
        currentKind.success &&
        !DECISION_ALLOWED_ACTIONS[currentKind.data].includes(envelope.response.action)
      ) {
        return {
          kind: "waiting",
          reason: "stored resume cannot answer the current interrupt; restore the waiting projection",
        };
      }
      return { kind: "resume", envelope };
    }
    // A command/creation that is itself the interrupted operation is a recovery of
    // a still-waiting job. A NEW operation admitted while an interrupt is pending
    // cannot run as-is (it would be silently swallowed), so the worker turns it
    // into the internal `modify` branch of the current interrupt — for a chat
    // request AND for a typed command (Phase 11). The old decision is resolved
    // explicitly once the new operation succeeds; a typed command then applies
    // through the deterministic dispatcher without an LLM call.
    if (state.values.operationId === operation.id) {
      return {
        kind: "waiting",
        reason: "operation is waiting at an unanswered interrupt; restore the waiting projection",
      };
    }
    const chatPayload = chatCommandPayloadSchema.safeParse(operation.payload);
    const commandPayload = domainCommandSchema.safeParse(operation.payload);
    if (options.pendingDecisionId && (chatPayload.success || commandPayload.success)) {
      return {
        kind: "resume",
        envelope: graphResumeEnvelopeSchema.parse({
          operationId: operation.id,
          acceptedRevision: operation.acceptedRevision,
          decisionId: options.pendingDecisionId,
          response: { action: "modify", commandOperationId: operation.id },
        }),
      };
    }
    return {
      kind: "conflict",
      message: "a new command cannot run while an interrupt is pending; resume the decision first",
    };
  }

  // Unfinished tasks with no unanswered interrupt: rerun only unfinished work —
  // and only for the operation that owns the checkpoint. A DIFFERENT operation
  // must start fresh: recovering would replay the stale `chatMessage`/`operationId`
  // and could trigger a paid call for the previous message.
  if (state.next.length > 0) {
    if (state.values.operationId === operation.id) {
      return { kind: "recover", input: null };
    }
    return operation.kind === "decision"
      ? { kind: "conflict", message: "the interrupted checkpoint belongs to another operation" }
      : { kind: "start", input: buildStartInput(operation) };
  }

  // Completed checkpoint.
  if (operation.kind === "decision") {
    // Same operation already finished: repair the projection without re-execution.
    // A decision op that is not the completed operation is a stale resume.
    return state.values.operationId === operation.id
      ? { kind: "reconcile" }
      : { kind: "conflict", message: "no matching interrupt for this resume" };
  }
  // New command/creation after END: plain new-operation input, restart at START.
  return { kind: "start", input: buildStartInput(operation) };
}
