import type { Pool } from "pg";
import type { OperationFencingContext } from "@odft/persistence";
import { runCoordinatorOperation, type CoordinatorDispatchDeps } from "@odft/workflow";
import type { TravelPorts } from "@odft/workflow";
import type { OperationDriver } from "./driver.js";
import { startLeaseRenewal } from "./lease.js";

/**
 * Phase 07 coordinator driver: adapts the SDK-free coordinator dispatcher to
 * the worker claim loop. It reuses the same travel ports factory as the graph
 * driver (the services are the canonical domain layer) but never builds a
 * LangGraph graph and never touches the checkpointer.
 */

export interface CoordinatorDriverOptions {
  readonly pool: Pool;
  readonly workerId: string;
  readonly transport: CoordinatorDispatchDeps["transport"];
  readonly agents: CoordinatorDispatchDeps["agents"];
  /** Ports bound to one claimed operation's fenced authority. */
  readonly portsFactory: (ctx: OperationFencingContext) => TravelPorts;
  readonly delegationWaitMs?: number;
  readonly logger?: (record: Record<string, unknown>) => void;
}

export function createCoordinatorDriver(options: CoordinatorDriverOptions): OperationDriver {
  return {
    async runOperation(claim) {
      const ctx: OperationFencingContext = {
        operationId: claim.operationId,
        tripId: claim.tripId,
        fencingToken: claim.fencingToken,
      };
      // The coordinator renews its lease exactly like the graph driver: a slow
      // specialist read can never let a second claim start the same operation.
      const abort = new AbortController();
      const stopRenewal = startLeaseRenewal(options.pool, claim, abort, {
        onLost: (error) => {
          options.logger?.({
            level: "warn",
            component: "coordinator",
            message: "lease lost",
            operationId: claim.operationId,
            reason: error instanceof Error ? error.message : String(error),
          });
        },
      });
      try {
        await runCoordinatorOperation(
          {
            pool: options.pool,
            transport: options.transport,
            ports: options.portsFactory(ctx),
            agents: options.agents,
            signal: abort.signal,
            ...(options.delegationWaitMs !== undefined ? { delegationWaitMs: options.delegationWaitMs } : {}),
            ...(options.logger ? { logger: options.logger } : {}),
          },
          claim,
        );
      } finally {
        stopRenewal();
      }
    },
  };
}
