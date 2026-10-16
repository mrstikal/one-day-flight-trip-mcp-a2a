"use client";

import { useCallback, useState } from "react";
import type { TripProjection } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { retryOperation } from "@/lib/decision-client";
import { FailedCard } from "@/components/wizard/FlightGating";

/**
 * Recovery state (`recoveryRequired` / `workflow_status = failed`): the planner
 * stopped with an unfinished failed checkpoint. The owner retry re-runs only the
 * unfinished work of the operation that owns it — a newer rejected conflict row
 * is never the recovery target.
 */
export function PlanningStoppedCard({
  tripId,
  projection,
  onRetried,
}: {
  readonly tripId: string;
  readonly projection: TripProjection;
  readonly onRetried: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const failedOperation = [...projection.operations]
    .reverse()
    .find((operation) => operation.status === "failed");
  const targetOperationId = projection.trip.recoveryOperationId ?? failedOperation?.operationId;

  const retry = useCallback(
    async (operationId: string): Promise<void> => {
      setBusy(true);
      setError(undefined);
      try {
        await retryOperation(tripId, operationId, projection.trip.revision);
        onRetried();
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : "The retry could not be requested.");
      } finally {
        setBusy(false);
      }
    },
    [onRetried, projection.trip.revision, tripId],
  );

  return (
    <div className="flex flex-col gap-3">
      <FailedCard
        message="The planner stopped before finishing this trip. Retrying re-runs only the unfinished work."
        canRetry={Boolean(targetOperationId)}
        busy={busy}
        onRetry={() => {
          if (targetOperationId) {
            void retry(targetOperationId);
          }
        }}
      />
      {error ? (
        <p role="alert" className="text-sm text-clay">
          {error}
        </p>
      ) : null}
    </div>
  );
}
