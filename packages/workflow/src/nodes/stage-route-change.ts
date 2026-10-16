import type { DomainCommand } from "@odft/contracts";
import { fingerprint } from "@odft/domain";
import type { TravelUpdate } from "../travel/state.js";
import type { TravelPorts } from "../travel/ports.js";

/**
 * Phase 11 route-change staging (03-langgraph-design.md section 10).
 *
 * When an admitted `set_route` batch would invalidate confirmed reservations,
 * the batch is NOT applied. This helper builds the impact preview and the
 * deferred command batch that the `route_change_confirmation` decision carries;
 * the reservations stay active until the user confirms and `commit_route_change`
 * applies the batch and cancels them in one transaction.
 *
 * Returns a discriminated result: `staged` (the confirmation decision update),
 * `noop` (a `set_route` that does not change any route field), or `applied`
 * (safe to apply directly: no confirmed reservation is affected).
 */
export type RouteChangeStaging =
  | { readonly kind: "staged"; readonly update: TravelUpdate }
  | { readonly kind: "noop" }
  | { readonly kind: "applied" };

export async function stageRouteChangeIfImpactful(input: {
  readonly ports: TravelPorts;
  readonly nodeName: string;
  readonly tripId: string;
  readonly operationId: string;
  readonly commands: readonly DomainCommand[];
}): Promise<RouteChangeStaging> {
  const routeCommands = input.commands.filter((command) => command.type === "set_route");
  if (routeCommands.length === 0) {
    return { kind: "applied" };
  }
  const preview = await input.ports.runEffect(input.nodeName, "route_change_preview", () =>
    input.ports.previewRouteChange({
      tripId: input.tripId,
      operationId: input.operationId,
      commands: input.commands,
    }),
  );
  if (preview.affectedReservations.length === 0) {
    // A same-value command changes nothing; it must not force a fresh flight
    // choice (or lose the current step) just because it names a route field.
    return preview.changedFields.length === 0 ? { kind: "noop" } : { kind: "applied" };
  }
  const update: TravelUpdate = {
    commandType: "route_change",
    commandPayload: routeCommands[0],
    routeChangeProposalId: preview.proposalId,
    routeChangePreview: {
      proposalId: preview.proposalId,
      commands: [...input.commands],
      changedFields: [...preview.changedFields],
      from: preview.from,
      to: preview.to,
      affectedReservations: [...preview.affectedReservations],
    },
    nextDecisionKind: "route_change_confirmation",
    nextWork: "decision",
    decisionFingerprint: fingerprint({
      kind: "route_change_confirmation",
      tripId: input.tripId,
      operationId: input.operationId,
      proposalId: preview.proposalId,
      affectedReservationIds: preview.affectedReservations.map((entry) => entry.id).sort(),
    }),
    gate: "pending",
  };
  return { kind: "staged", update };
}
