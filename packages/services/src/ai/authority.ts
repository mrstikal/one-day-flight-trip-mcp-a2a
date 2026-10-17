import type { OperationFencingContext } from "@odft/persistence";

/**
 * Phase 02: explicit execution authority.
 *
 * Every service call that can read or write a trip's state runs under a tagged
 * authority that names the exact execution context it was granted for. Today the
 * only variant is a claimed workflow operation (the worker's fencing token); the
 * tagged union exists so later phases can add narrower grants (for example a
 * read-only query authority for MCP tools) WITHOUT giving those callers the
 * operation variant. Services must never infer authority from ambient state:
 * it is always an explicit input.
 */
export interface OperationAuthority {
  readonly kind: "operation";
  readonly tripId: string;
  readonly operationId: string;
  /** Fencing token of the claiming worker; every fenced write verifies it. */
  readonly fencingToken: string;
}

export type ServiceAuthority = OperationAuthority;

/** Build the authority of a claimed operation (the worker's execution context). */
export function operationAuthority(context: OperationFencingContext): OperationAuthority {
  return {
    kind: "operation",
    tripId: context.tripId,
    operationId: context.operationId,
    fencingToken: context.fencingToken,
  };
}

/** The persistence-level fencing context of an authority. */
export function fencingContext(authority: ServiceAuthority): OperationFencingContext {
  return {
    operationId: authority.operationId,
    tripId: authority.tripId,
    fencingToken: authority.fencingToken,
  };
}

/**
 * The fencing context for a domain write, refusing a write that targets a
 * different operation/trip than the granted authority, so a stale or misrouted
 * task can never borrow the current worker's token.
 */
export function fencingContextFor(
  authority: ServiceAuthority,
  operationId: string,
  tripId: string,
): OperationFencingContext {
  if (operationId !== authority.operationId || tripId !== authority.tripId) {
    throw new Error("research write targets a different operation than the claimed one");
  }
  return fencingContext(authority);
}

/**
 * Phase 05: tagged DELEGATED AI authority of an agent process.
 *
 * An agent never receives a coordinator fencing token. Its authority is a
 * lookup key that is revalidated against the persisted delegation on every
 * step; the coordinator fence variant above stays reserved for worker paths.
 */
export interface DelegatedAuthority {
  readonly kind: "delegation";
  readonly delegationId: string;
  readonly agentIdentity: string;
  readonly skillId: string;
  /** Canonical A2A task of the delegation (stable across continuations). */
  readonly taskId: string;
  /** Correlation id of the invocation, never a business fingerprint input. */
  readonly traceId: string;
}

export function delegationAuthority(input: {
  delegationId: string;
  agentIdentity: string;
  skillId: string;
  taskId: string;
  traceId: string;
}): DelegatedAuthority {
  return {
    kind: "delegation",
    delegationId: input.delegationId,
    agentIdentity: input.agentIdentity,
    skillId: input.skillId,
    taskId: input.taskId,
    traceId: input.traceId,
  };
}

/**
 * A refused delegated paid-call step, carrying the ledger function's own code
 * (`DELEGATION_REVOKED`, `INPUT_EXPIRED`, `STALE_AGENT_RESULT`,
 * `AI_BUDGET_EXCEEDED`, `TASK_BUDGET_EXCEEDED`, ...) so agent callers can report
 * the real governance reason instead of collapsing it into a generic error.
 */
export class DelegatedCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DelegatedCallError";
    this.code = code;
  }
}
