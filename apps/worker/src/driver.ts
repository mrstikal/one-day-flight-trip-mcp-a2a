import type { Pool } from "pg";
import {
  Command,
  isGraphInterrupt,
  type BaseCheckpointSaver,
  type StateSnapshot,
} from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  appendConversationMessage,
  contentHash,
  finalizeConflict,
  finalizeFailure,
  finalizeSuccess,
  finalizeWaiting,
  getPendingDecisionForTrip,
  getTrip,
  MAX_AUTO_CLAIMS_PER_ROUND,
  projectSafeEvent,
  releaseClaim,
  StaleFencingError,
  withEffect,
  type ClaimedOperation,
  type OperationFencingContext,
} from "@odft/persistence";
import { decisionKindSchema, type DecisionKind } from "@odft/contracts";
import {
  chooseInvocation,
  reconcileCompleted,
  type CheckpointView,
  type ChooseInvocationOptions,
  type HarnessPorts,
  type InvocationChoice,
  type InvocationOperation,
} from "@odft/workflow";
import { FencedSaver } from "./checkpointer/fenced-saver.js";
import { startLeaseRenewal } from "./lease.js";
import { acquireTripLock, releaseTripLock } from "./trip-lock.js";

/**
 * Single-trip graph driver (03-langgraph-design.md section 8). The worker is the
 * only graph invoker; every invocation uses the fenced saver, an operation-bound
 * context, `durability: "sync"`, `recursionLimit: 100`, and an abort signal.
 */

export interface WorkerGraph {
  getState(config: RunnableConfig): Promise<StateSnapshot>;
  stream(
    input: unknown,
    options?: Partial<Record<string, unknown>>,
  ): Promise<AsyncIterable<unknown>>;
}

export interface DriverLogger {
  (record: Record<string, unknown>): void;
}

export interface DriverDeps {
  readonly operationsPool: Pool;
  readonly guardPool: Pool;
  readonly saverPool: Pool;
  readonly lockPool: Pool;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly graphVersion: string;
  readonly buildGraph: (checkpointer: BaseCheckpointSaver) => WorkerGraph;
  readonly buildSaver: () => BaseCheckpointSaver;
  /**
   * Build the non-checkpointed invocation context (server-side ports). Defaults
   * to the Phase 05 harness ports. The production travel graph injects richer
   * ports here.
   */
  readonly portsFactory?: (ctx: OperationFencingContext, signal?: AbortSignal) => unknown;
  /**
   * Phase 11: safe, versioned graph definition persisted as `graph.initialized`
   * from the same registry that built the graph. The inspector renders it; it
   * carries labels and topology only.
   */
  readonly graphDefinition?: unknown;
  /** Graph-specific invocation selection. Defaults to the harness chooser. */
  readonly chooseInvocation?: (
    state: CheckpointView | null,
    operation: InvocationOperation,
    options: ChooseInvocationOptions,
  ) => InvocationChoice;
  readonly logger?: DriverLogger;
  /** Shutdown signal: aborts local graph work and releases locks immediately. */
  readonly signal?: AbortSignal;
}

export interface OperationDriver {
  runOperation(claim: ClaimedOperation): Promise<void>;
}

function toCheckpointView(snapshot: StateSnapshot | undefined): CheckpointView | null {
  if (!snapshot) {
    return null;
  }
  const tasks = snapshot.tasks ?? [];
  const checkpointId = snapshot.config?.configurable?.checkpoint_id;
  return {
    values:
      snapshot.values && typeof snapshot.values === "object"
        ? (snapshot.values as Record<string, unknown>)
        : {},
    next: snapshot.next ?? [],
    checkpointId: typeof checkpointId === "string" ? checkpointId : null,
    interrupts: tasks.flatMap((task) =>
      (task.interrupts ?? []).map((interrupt) => ({
        id: interrupt.id ?? "",
        value: interrupt.value,
      })),
    ),
  };
}

function isFencingLoss(error: unknown): boolean {
  return error instanceof StaleFencingError;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  if (error instanceof Error) {
    return error.name === "InvalidUpdateError" ? "REDUCER_CONFLICT" : error.name;
  }
  return "UNKNOWN";
}

/**
 * Deterministic failures that a retry can never fix (a stale/invalid request or a
 * poisoned domain state). They are finalized as an operation conflict so the
 * client refreshes, instead of being auto-retried into `recovery_required`.
 */
const TERMINAL_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "REDUCER_CONFLICT",
  "STALE_DECISION",
  "STALE_REVISION",
  "STALE_ROUTE_APPROVAL",
  "PROPOSAL_EXPIRED",
  "PROPOSAL_SUPERSEDED",
  "OFFER_UNAVAILABLE",
  "OFFER_MISMATCH",
  "DISCLAIMER_REQUIRED",
  "REPLACEMENT_CONFIRMATION_REQUIRED",
  "CREATION_CONFLICT",
  "VALIDATION_FAILED",
  "CONFLICT",
  "FORBIDDEN",
  "NOT_FOUND",
  "REF_GENERATION_FAILED",
  // Phase 10: approving a stale draft or one that is no longer approvable can
  // never succeed by retrying; the client refreshes and rebuilds.
  "ITINERARY_NOT_APPROVABLE",
  "STALE_ITINERARY",
  // AI failures are never automatically retried by the graph layer: the adapter
  // already owns its single repair/retry, and a second graph-level round would
  // stack billable calls on the same message (06-ai-agent-design.md section 9).
  "AI_NOT_CONFIGURED",
  "AI_CAPABILITY_UNKNOWN",
  "AI_BUDGET_EXCEEDED",
  "AI_PRICING_UNKNOWN",
  "AI_AUTH_FAILED",
  "AI_UNSUPPORTED",
  "AI_INPUT_OVERFLOW",
  "AI_SCHEMA_INVALID",
  "AI_TIMEOUT",
  "AI_TRANSPORT_FAILED",
  // AI_ABORTED is NOT terminal: a graceful shutdown aborts in-flight work, and the
  // operation must stay recoverable (released to `queued`) rather than failed.
]);

/** True when a failure code is a permanent conflict a retry can never resolve. */
export function isTerminalConflictCode(code: string): boolean {
  return TERMINAL_CONFLICT_CODES.has(code);
}

/**
 * Build the fenced event writer for one claimed operation. Exported so graph
 * ports can persist safe progress events (Phase 09 domain timing/attempt
 * evidence) under the same fencing rule as the driver's own events.
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
    // the safe allowlist BEFORE storage (Phase 11).
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
 * Build the fenced effect runner for one claimed operation. Exported so richer
 * graphs (the production travel graph) can reuse the exact same fencing and
 * advisory-lock semantics as the Phase 05 harness.
 */
export function createFencedRunEffect(
  operationsPool: Pool,
  ctx: OperationFencingContext,
): <T>(nodeName: string, effectScope: string, fn: () => Promise<T>) => Promise<T> {
  return async <T>(nodeName: string, effectScope: string, fn: () => Promise<T>): Promise<T> => {
    const client = await operationsPool.connect();
    try {
      await client.query("BEGIN");
      // Fence the effect: a stale worker (token rotated) performs no callback.
      // `FOR SHARE` also blocks a concurrent fencing-token rotation until the
      // effect transaction commits.
      const owned = await client.query(
        `SELECT 1 FROM odft_app.workflow_operations
          WHERE id = $1 AND trip_id = $2 AND fencing_token = $3::bigint
          FOR SHARE`,
        [ctx.operationId, ctx.tripId, ctx.fencingToken],
      );
      if (owned.rowCount !== 1) {
        throw new StaleFencingError(ctx.operationId);
      }
      // Serialize concurrent identical effect scopes so the callback runs once.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `effect:${ctx.operationId}:${nodeName}:${effectScope}`,
      ]);
      const result = await withEffect<T>(
        client,
        { operationId: ctx.operationId, nodeName, effectScope },
        fn,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback failures; the original error is what matters.
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

export function createOperationDriver(deps: DriverDeps): OperationDriver {
  const logger = deps.logger ?? (() => {});
  const selectInvocation = deps.chooseInvocation ?? chooseInvocation;

  const insertFencedEvent = createFencedEventWriter(deps.operationsPool);

  function buildPorts(ctx: OperationFencingContext): HarnessPorts {
    return {
      now: () => new Date(),
      runEffect: createFencedRunEffect(deps.operationsPool, ctx),
    };
  }

  async function persistWaiting(
    claim: ClaimedOperation,
    view: CheckpointView,
  ): Promise<void> {
    const descriptor = (view.interrupts[0]?.value ?? {}) as Record<string, unknown>;
    const kindParsed = decisionKindSchema.safeParse(descriptor.kind);
    const kind: DecisionKind = kindParsed.success ? kindParsed.data : "clarification";
    const allowedOptionIds = stringArray(descriptor.allowedOptionIds);
    const allowedOfferIds = stringArray(descriptor.allowedOfferIds);
    const proposalId =
      typeof descriptor.proposalId === "string" ? descriptor.proposalId : undefined;
    // The graph may supply an explicit fingerprint (the booking decision binds
    // the proposal's source fingerprint); otherwise it derives from the kind,
    // interrupt identity, offered options/offers, and proposal.
    const fingerprint =
      typeof descriptor.sourceFingerprint === "string" &&
      /^[a-f0-9]{64}$/.test(descriptor.sourceFingerprint)
        ? descriptor.sourceFingerprint
        : contentHash({
            kind,
            interruptId: view.interrupts[0]?.id ?? null,
            allowedOptionIds,
            allowedOfferIds,
            proposalId: proposalId ?? null,
          });
    const optionPayload =
      descriptor.optionPayload !== null &&
      typeof descriptor.optionPayload === "object" &&
      !Array.isArray(descriptor.optionPayload)
        ? descriptor.optionPayload
        : Array.isArray(descriptor.optionPayload) && descriptor.optionPayload.length > 0
          ? descriptor.optionPayload
          : undefined;
    // Operation transition, pending decision, trip projection, and event commit
    // together in one fencing-token-guarded transaction.
    const committed = await finalizeWaiting(
      deps.operationsPool,
      { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
      {
        kind,
        fingerprint,
        allowedOptionIds,
        allowedOfferIds,
        ...(proposalId ? { proposalId } : {}),
        ...(optionPayload !== undefined ? { optionPayload } : {}),
        checkpointId: view.checkpointId ?? null,
        interruptId: view.interrupts[0]?.id ?? null,
        graphVersion: deps.graphVersion,
        createdRevision: claim.acceptedRevision,
      },
    );
    // A chat request that applied its commands and then opened a decision still
    // needs its outcome message — written only after the waiting state committed.
    if (committed && isChatOperation(claim)) {
      const content = chatOutcomeMessage(view.values as Record<string, unknown>);
      if (content) {
        await appendChatMessage(claim, content, {
          kind: view.values.intentStatus ?? "commands",
          interpretation: view.values.intentInterpretation ?? undefined,
        });
      }
    }
  }

  /**
   * Assistant outcome text for a chat operation, derived from the committed graph
   * state (never a fabricated success). Written only AFTER finalizeSuccess, so a
   * failed operation can never leave an "applied" message behind.
   */
  function chatOutcomeMessage(values: Record<string, unknown>): string | undefined {
    const status = values.intentStatus;
    const interpretation =
      typeof values.intentInterpretation === "string" ? values.intentInterpretation : undefined;
    const pendingKind = typeof values.nextDecisionKind === "string" ? values.nextDecisionKind : null;
    // Phase 11: a search that refreshed offers presents them as a decision, and a
    // route change that would invalidate reservations opens the impact card in
    // the assistant rail. Neither changed a confirmed reservation.
    if (status === "commands" && pendingKind === "route_change_confirmation") {
      return `${interpretation ?? "Your route change was prepared."} Confirm the impact preview in the assistant rail; nothing is cancelled until you confirm.`;
    }
    if (status === "commands") {
      const refreshed =
        pendingKind === "hotel_choice" || pendingKind === "program_choices"
          ? " Refreshed alternatives are ready."
          : "";
      return `Applied: ${interpretation ?? "your request"}.${refreshed} No confirmed reservation was changed.`;
    }
    if (status === "unsupported") {
      return interpretation ?? "I could not interpret that request; the graphical controls remain available.";
    }
    if (status === "search_pending") {
      return `${interpretation ?? "Your search request was recorded."} Alternative search is not available in this demo step yet; nothing was changed.`;
    }
    return undefined;
  }

  /** The admitted payload of a chat request (as opposed to a graphical control). */
  function isChatOperation(claim: ClaimedOperation): boolean {
    const payload = claim.payload as { kind?: unknown } | null;
    return claim.kind === "command" && payload?.kind === "chat";
  }

  async function appendChatMessage(
    claim: ClaimedOperation,
    content: string,
    interpretation: unknown,
  ): Promise<void> {
    try {
      await appendConversationMessage(deps.operationsPool, {
        tripId: claim.tripId,
        role: "assistant",
        content: content.slice(0, 2000),
        interpretation,
        operationId: claim.operationId,
        // Deterministic dedupe key: a crash replay cannot append a second bubble.
        requestId: claim.operationId,
        fence: {
          operationId: claim.operationId,
          tripId: claim.tripId,
          fencingToken: claim.fencingToken,
        },
      });
    } catch (error) {
      // A stale fence or a concurrent write must not fail the operation result.
      logger({
        level: "warn",
        component: "driver",
        message: `assistant message was not persisted: ${
          error instanceof Error ? error.message : String(error)
        }`,
        operationId: claim.operationId,
      });
    }
  }

  async function persistSuccess(
    claim: ClaimedOperation,
    view: CheckpointView,
    answeredDecisionId?: string,
  ): Promise<void> {
    const operation = {
      id: claim.operationId,
      tripId: claim.tripId,
      kind: claim.kind,
      acceptedRevision: claim.acceptedRevision,
      payload: claim.payload,
    };
    const reconciliation = reconcileCompleted(view, operation);
    const payload = (claim.payload ?? {}) as Record<string, unknown>;
    const resolveDecisionId =
      answeredDecisionId ??
      (claim.kind === "decision" && typeof payload.decisionId === "string"
        ? payload.decisionId
        : undefined);
    const blocked =
      reconciliation.lastOutcome === "no_feasible_route" ||
      reconciliation.lastOutcome === "no_feasible_schedule" ||
      reconciliation.lastOutcome === "research_failed";
    const committed = await finalizeSuccess(
      deps.operationsPool,
      { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
      {
        result: reconciliation,
        summary: reconciliation.summary,
        workflowStatus: blocked ? "blocked" : "ready",
        ...(resolveDecisionId ? { resolveDecisionId } : {}),
      },
    );
    if (committed && isChatOperation(claim)) {
      const content = chatOutcomeMessage(view.values as Record<string, unknown>);
      if (content) {
        await appendChatMessage(claim, content, {
          kind: view.values.intentStatus ?? "commands",
          interpretation: view.values.intentInterpretation ?? undefined,
        });
      }
    }
  }

  async function fail(claim: ClaimedOperation, error: unknown): Promise<void> {
    const code = safeErrorCode(error);
    // A deterministic failure (stale/invalid request, poisoned domain state) is a
    // permanent conflict the client must resolve by refreshing; retrying can never
    // succeed and would only exhaust the claim budget into `recovery_required`.
    if (isTerminalConflictCode(code)) {
      const message = error instanceof Error ? error.message : code;
      if (claim.kind === "decision") {
        // The resume consumed its interrupt before this failure, so the pending
        // decision can no longer be answered (a new resume would only conflict).
        // Expose the unfinished failed checkpoint for explicit owner recovery:
        // retrying the SAME operation re-runs only the unfinished work.
        const recovered = await finalizeFailure(
          deps.operationsPool,
          { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
          { code, message, exhausted: true },
        );
        if (recovered) {
          logger({ level: "warn", component: "driver", message: "decision resume failed terminally; owner recovery required", operationId: claim.operationId, code });
        }
        return;
      }
      const committed = await finalizeConflict(
        deps.operationsPool,
        { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
        { code, message },
      );
      // A failed chat request must not stay silent in the conversation.
      if (committed && isChatOperation(claim)) {
        await appendChatMessage(
          claim,
          `I could not complete that request (${code}). No confirmed reservation was changed.`,
          { kind: "unsupported", interpretation: `request failed: ${code}` },
        );
      }
      return;
    }
    const exhausted = claim.autoClaims >= MAX_AUTO_CLAIMS_PER_ROUND;
    const committed = await finalizeFailure(
      deps.operationsPool,
      { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
      { code, exhausted },
    );
    if (committed && exhausted) {
      logger({ level: "warn", component: "driver", message: "operation exhausted automatic claims", operationId: claim.operationId, code });
    } else if (committed) {
      logger({
        level: "info",
        component: "driver",
        message: `operation failed; requeued for a bounded retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
        operationId: claim.operationId,
        code,
      });
    }
  }

  async function invoke(
    graph: WorkerGraph,
    claim: ClaimedOperation,
    input: unknown,
    abort: AbortController,
  ): Promise<void> {
    const ctx = {
      operationId: claim.operationId,
      tripId: claim.tripId,
      fencingToken: claim.fencingToken,
    };
    const context = {
      operationId: claim.operationId,
      ports: deps.portsFactory ? deps.portsFactory(ctx, abort.signal) : buildPorts(ctx),
    };
    if (deps.graphDefinition !== undefined) {
      // Persist the definition from the same worker registry before execution so
      // the inspector can render real nodes/edges even for a failed first run.
      await insertFencedEvent(ctx, {
        type: "graph.initialized",
        payload: deps.graphDefinition as Record<string, unknown>,
      });
    }
    const stream = await graph.stream(input, {
      configurable: { thread_id: claim.tripId },
      durability: "sync",
      recursionLimit: 100,
      context,
      signal: abort.signal,
      // "updates" is the completion evidence; "tasks" adds the genuine START
      // evidence the inspector needs to highlight the node actually executing
      // (a task-create event carries `triggers`, a task-result carries `result`).
      streamMode: ["updates", "tasks"],
    });
    for await (const chunk of stream) {
      // A multi-mode stream yields `[mode, payload]` tuples; unwrap defensively.
      const tuple =
        Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string"
          ? (chunk as [string, unknown])
          : (["updates", chunk] as [string, unknown]);
      const [mode, payload] = tuple;
      if (mode === "tasks") {
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const task = payload as Record<string, unknown>;
          if (typeof task.name === "string" && Object.prototype.hasOwnProperty.call(task, "triggers")) {
            await insertFencedEvent(ctx, { type: "node.started", payload: { node: task.name } });
          }
        }
        continue;
      }
      if (mode !== "updates") {
        continue;
      }
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        for (const node of Object.keys(payload as Record<string, unknown>)) {
          await insertFencedEvent(ctx, { type: "node.updated", payload: { node } });
        }
      }
    }
  }

  async function runOperation(claim: ClaimedOperation): Promise<void> {
    const trip = await getTrip(deps.operationsPool, claim.tripId);
    if (!trip) {
      await releaseClaim(deps.operationsPool, claim);
      return;
    }

    const abort = new AbortController();
    const onShutdown = (): void => abort.abort(new Error("worker shutdown"));
    if (deps.signal?.aborted) {
      onShutdown();
    } else {
      deps.signal?.addEventListener("abort", onShutdown, { once: true });
    }

    const lock = await acquireTripLock(deps.lockPool, claim.tripId, {
      onLost: (error) => {
        // A lost lock connection means this process no longer owns the trip.
        logger({ level: "warn", component: "driver", message: "trip lock lost", error: String(error) });
        abort.abort(error);
      },
    });
    if (!lock) {
      deps.signal?.removeEventListener("abort", onShutdown);
      // Another worker holds the trip; leave the lease to expire.
      logger({ level: "info", component: "driver", message: "trip lock busy", tripId: claim.tripId });
      return;
    }

    const stopRenewal = startLeaseRenewal(deps.operationsPool, claim, abort, {
      onLost: (error) => logger({ level: "warn", component: "driver", message: "lease lost", error: String(error) }),
    });

    const ctx = {
      operationId: claim.operationId,
      tripId: claim.tripId,
      fencingToken: claim.fencingToken,
    };
    const fenced = new FencedSaver(deps.buildSaver(), deps.guardPool, ctx);
    const graph = deps.buildGraph(fenced);

    try {
      const snapshot = await graph.getState({ configurable: { thread_id: claim.tripId } });
      const view = toCheckpointView(snapshot);
      const pending = await getPendingDecisionForTrip(deps.operationsPool, claim.tripId);
      const choice: InvocationChoice = selectInvocation(
        view,
        {
          id: claim.operationId,
          tripId: claim.tripId,
          kind: claim.kind,
          acceptedRevision: claim.acceptedRevision,
          payload: claim.payload,
        },
        pending
          ? { pendingDecisionId: pending.id, pendingDecisionKind: pending.kind }
          : {},
      );
      // A resume answers the decision it carries; on success that decision is
      // resolved even when the resuming operation is an internal `modify`.
      const answeredDecisionId =
        choice.kind === "resume" ? choice.envelope.decisionId : undefined;

      switch (choice.kind) {
        case "conflict": {
          // A resume rejected because the checkpoint head is unfinished work owned
          // by a different (failed) operation has no answerable interrupt left:
          // restore owner recovery for that operation instead of a dead decision.
          const unfinishedOwner =
            claim.kind === "decision" &&
            view !== null &&
            view.interrupts.length === 0 &&
            view.next.length > 0 &&
            typeof view.values.operationId === "string" &&
            view.values.operationId.length > 0
              ? view.values.operationId
              : undefined;
          await finalizeConflict(
            deps.operationsPool,
            { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
            {
              code: "STALE_DECISION",
              message: choice.message,
              ...(unfinishedOwner ? { unfinishedOperationId: unfinishedOwner } : {}),
            },
          );
          return;
        }
        case "waiting": {
          const current = toCheckpointView(await graph.getState({ configurable: { thread_id: claim.tripId } }));
          if (current) {
            await persistWaiting(claim, current);
          }
          return;
        }
        case "reconcile": {
          if (view) {
            await persistSuccess(claim, view);
          }
          return;
        }
        case "recover": {
          await invoke(graph, claim, null, abort);
          break;
        }
        case "start": {
          await invoke(graph, claim, choice.input, abort);
          break;
        }
        case "resume": {
          await invoke(graph, claim, new Command({ resume: choice.envelope }), abort);
          break;
        }
      }

      const finalSnapshot = await graph.getState({ configurable: { thread_id: claim.tripId } });
      const finalView = toCheckpointView(finalSnapshot);
      if (finalView && finalView.interrupts.length > 0) {
        await persistWaiting(claim, finalView);
      } else if (finalView) {
        await persistSuccess(claim, finalView, answeredDecisionId);
      }
    } catch (error) {
      if (isFencingLoss(error)) {
        logger({ level: "warn", component: "driver", message: "stale fencing token; abandoning local work", operationId: claim.operationId });
        return;
      }
      if (isGraphInterrupt(error)) {
        const interrupted = toCheckpointView(
          await graph.getState({ configurable: { thread_id: claim.tripId } }),
        );
        if (interrupted) {
          await persistWaiting(claim, interrupted);
        }
        return;
      }
      await fail(claim, error);
    } finally {
      stopRenewal();
      deps.signal?.removeEventListener("abort", onShutdown);
      await releaseTripLock(lock);
    }
  }

  return { runOperation };
}
