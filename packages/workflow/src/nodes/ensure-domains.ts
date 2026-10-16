import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 07: idempotently materialize the non-flight inventories (hotels and the
 * three meals plus activities) over the persisted snapshot. The scenario service
 * appends at most one version per call, so a crash-replay does not extend twice.
 */
export async function ensureDomainsNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const result = await ports.runEffect("ensure_domains", "all", () =>
    ports.ensureDomains(state.tripId),
  );
  return {
    domainsEnsured: true,
    snapshotId: result.snapshotId,
  };
}
