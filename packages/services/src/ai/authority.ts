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
