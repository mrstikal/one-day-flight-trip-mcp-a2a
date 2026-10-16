import type { FeasibleRouteApproval, RouteInputs } from "@odft/contracts";
import { DomainError } from "@odft/domain";
import { computeRouteFingerprint } from "./fingerprints.js";

/**
 * Independent approval freshness guards (04-domain-model.md section 4,
 * FR-FEAS-8). Both the flight generator and the booking service re-read the
 * persisted approval and compare its fingerprint with a fresh computation from
 * current inputs; a stale or foreign approval is rejected.
 */

export function isApprovalCurrent(approval: FeasibleRouteApproval, current: RouteInputs): boolean {
  if (approval.status !== "FEASIBLE" || approval.expiresWithInputs !== true) {
    return false;
  }
  if (approval.policyVersion !== current.routePolicyVersion) {
    return false;
  }
  return approval.fingerprint === computeRouteFingerprint(current);
}

export function assertApprovalCurrent(approval: FeasibleRouteApproval, current: RouteInputs): void {
  if (!isApprovalCurrent(approval, current)) {
    throw new DomainError(
      "STALE_ROUTE_APPROVAL",
      "the route approval does not match the current route inputs and must be revalidated",
    );
  }
}
