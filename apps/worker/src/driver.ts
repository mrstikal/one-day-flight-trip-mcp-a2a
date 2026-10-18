import type { Pool } from "pg";
import {
  assertOperationFence,
  getTrip,
  operationEffectLockKey,
  projectSafeEvent,
  readEffect,
  releaseClaim,
  writeEffect,
  type ClaimedOperation,
  type OperationFencingContext,
} from "@odft/persistence";
import {
  runCoordinatorOperation,
  type CoordinatorDispatchDeps,
  type TravelPorts,
} from "@odft/workflow";
import { startLeaseRenewal } from "./lease.js";
import { acquireTripLock, releaseTripLock } from "./trip-lock.js";

/**
 * The single worker driver (Phase 11). It adapts the SDK-free coordinator
 * dispatcher to the worker claim loop and never builds a graph or touches a
 * checkpointer. Domain access goes through the ports bound to one claimed
 * operation's fenced authority.
 */

export interface OperationDriver {
  runOperation(claim: ClaimedOperation): Promise<void>;
}

export interface DriverLogger {
  (record: Record<string, unknown>): void;
}

export interface OperationDriverOptions {
  readonly pool: Pool;
  /** Dedicated pool for the session-level per-trip advisory lock. */
  readonly lockPool: Pool;
  readonly transport: CoordinatorDispatchDeps["transport"];
  readonly agents: CoordinatorDispatchDeps["agents"];
  /** Ports bound to one claimed operation's fenced authority. */
  readonly portsFactory: (ctx: OperationFencingContext, signal: AbortSignal) => TravelPorts;
  readonly delegationWaitMs?: number;
  readonly logger?: DriverLogger;
  /** Process shutdown signal; aborts in-flight coordinator work gracefully. */
  readonly signal?: AbortSignal;
}

export function createOperationDriver(options: OperationDriverOptions): OperationDriver {
  return {
    async runOperation(claim) {
      const trip = await getTrip(options.pool, claim.tripId);
      if (!trip) {
        await releaseClaim(options.pool, claim);
        return;
      }

      const abort = new AbortController();
      const onShutdown = (): void => abort.abort(new Error("worker shutdown"));
      if (options.signal?.aborted) {
        onShutdown();
      } else {
        options.signal?.addEventListener("abort", onShutdown, { once: true });
      }

      const lock = await acquireTripLock(options.lockPool, claim.tripId, {
        onLost: (error) => {
          options.logger?.({
            level: "warn",
            component: "coordinator",
            message: "trip lock lost",
            tripId: claim.tripId,
            reason: error instanceof Error ? error.message : String(error),
          });
          abort.abort(error);
        },
      });
      if (!lock) {
        options.signal?.removeEventListener("abort", onShutdown);
        // Another worker holds the trip; leave the lease to expire.
        options.logger?.({
          level: "info",
          component: "coordinator",
          message: "trip lock busy",
          tripId: claim.tripId,
        });
        return;
      }

      const ctx: OperationFencingContext = {
        operationId: claim.operationId,
        tripId: claim.tripId,
        fencingToken: claim.fencingToken,
      };
      // A slow specialist read can never let a second claim start the same
      // operation: the lease is renewed while the coordinator works.
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
            ports: options.portsFactory(ctx, abort.signal),
            agents: options.agents,
            signal: abort.signal,
            ...(options.delegationWaitMs !== undefined
              ? { delegationWaitMs: options.delegationWaitMs }
              : {}),
            ...(options.logger ? { logger: options.logger } : {}),
          },
          claim,
        );
      } finally {
        stopRenewal();
        options.signal?.removeEventListener("abort", onShutdown);
        await releaseTripLock(lock);
      }
    },
  };
}

/**
 * Build the fenced event writer for one claimed operation. Progress events are
 * accepted only while the operation still carries the admitted fencing token,
 * so a stale worker cannot append evidence after a lease handover.
 */
export function createFencedEventWriter(
  operationsPool: Pool,
): (
  ctx: { tripId: string; operationId: string; fencingToken: string },
  event: { type: string; payload: unknown },
) => Promise<void> {
  return async (ctx, event) => {
    // The fencing token alone identifies the admitted writer: it rotates on every
    // new claim, so a stale worker's events are rejected while the current owner's
    // events (including post-completion) are accepted. Payloads are projected to
    // the safe allowlist BEFORE storage.
    await operationsPool.query(
      `INSERT INTO odft_app.execution_events (trip_id, operation_id, type, payload)
       SELECT $1, $2, $3, $4::jsonb
        WHERE EXISTS (
          SELECT 1 FROM odft_app.workflow_operations
           WHERE id = $2 AND trip_id = $1 AND fencing_token = $5::bigint
        )`,
      [
        ctx.tripId,
        ctx.operationId,
        event.type,
        JSON.stringify(projectSafeEvent(event.type, event.payload)),
        ctx.fencingToken,
      ],
    );
  };
}

/**
 * Build the fenced effect runner for one claimed operation. A stale writer
 * performs no callback; concurrent identical effect scopes serialize so the
 * callback runs once.
 *
 * The operation row is locked only in two short transactions (ledger read and
 * ledger write). The callback runs between them under a per-operation advisory
 * gate that cancellation also takes BEFORE its trip lock: the effect therefore
 * never holds an operation lock while waiting for a callback that may take the
 * trip lock, and cancellation cannot interleave with an in-flight effect.
 */
export function createFencedRunEffect(
  operationsPool: Pool,
  ctx: OperationFencingContext,
): <T>(nodeName: string, effectScope: string, fn: () => Promise<T>) => Promise<T> {
  return async <T>(nodeName: string, effectScope: string, fn: () => Promise<T>): Promise<T> => {
    const key = { operationId: ctx.operationId, nodeName, effectScope };
    const gateKey = operationEffectLockKey(ctx.operationId);
    const client = await operationsPool.connect();
    let gateHeld = false;
    try {
      // Session-level gate: held across both short transactions AND the
      // callback, released only after the effect ledger write commits.
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [gateKey]);
      gateHeld = true;

      await client.query("BEGIN");
      // Fence the effect: a stale worker (token rotated) performs no callback.
      await assertOperationFence(client, ctx);
      const existing = await readEffect(client, key);
      await client.query("COMMIT");
      if (existing !== undefined) {
        return existing as T;
      }

      // Network/domain work happens with NO operation row lock held.
      const result = await fn();

      await client.query("BEGIN");
      // Re-check ownership after the callback: a lease handover that rotated
      // the token while the callback ran must not persist its result.
      await assertOperationFence(client, ctx);
      await writeEffect(client, key, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (gateHeld) {
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [gateKey])
          .catch(() => undefined);
      }
      client.release();
    }
  };
}
