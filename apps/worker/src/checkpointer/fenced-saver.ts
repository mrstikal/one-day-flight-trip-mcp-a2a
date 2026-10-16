import type { Pool } from "pg";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { acquireCheckpointGate, assertFencingCurrent, readOperationOwnership, type OperationFencingContext } from "@odft/persistence";

/**
 * Fenced checkpoint-write wrapper (02-architecture.md section 6).
 *
 * Wraps the official `PostgresSaver` `put`/`putWrites`. Each write:
 *  1. runs inside a short transaction-scoped `checkpoint-write:<tripId>`
 *     advisory gate on the SEPARATE guard pool (so the outer guard cannot
 *     starve the delegated write on the saver pool);
 *  2. performs a NON-LOCKING ownership read (never a row lock inside the gate,
 *     which would create a lock-order cycle with job claiming);
 *  3. delegates the official write only while the operation is still `running`
 *     under the exact fencing token.
 *
 * Lease claim/token rotation acquires the same gate before committing a new
 * token, so an admitted write finishes before rotation and every later stale
 * write is rejected.
 */
export class FencedSaver extends BaseCheckpointSaver {
  constructor(
    private readonly delegate: BaseCheckpointSaver,
    private readonly guardPool: Pool,
    private readonly ctx: OperationFencingContext,
  ) {
    super(delegate.serde);
  }

  override async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
    return this.delegate.get(config);
  }

  /**
   * Head reads must resolve the thread's causal leaf, not `ORDER BY
   * checkpoint_id DESC`.
   *
   * The upstream checkpoint-id generator keeps a monotonic (msecs, nsecs) clock
   * per module instance, and the package ships ESM and CJS builds with separate
   * state. Ids written by different instances within one run can therefore sort
   * backwards, and the saver's latest-checkpoint query then returns a checkpoint
   * from the MIDDLE of the run (observed live 2026-10-13: a completed creation
   * run finalized against a stale mid-run view, so its flight-choice interrupt
   * was never persisted and the trip stayed on "Preparing flight options…").
   *
   * Resolve "latest" causally instead: the newest checkpoint (max id) that no
   * other checkpoint names as its parent. Explicit `checkpoint_id` reads (resume,
   * time travel, delta reconstruction) are untouched, and the library's own ids
   * still back task-id derivation, so interruption semantics are unchanged.
   */
  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const explicit = config.configurable?.["checkpoint_id"];
    const threadId = config.configurable?.["thread_id"];
    if (typeof explicit === "string" || typeof threadId !== "string") {
      return this.delegate.getTuple(config);
    }
    const tuples: CheckpointTuple[] = [];
    for await (const tuple of this.delegate.list(config, { limit: 1000 })) {
      tuples.push(tuple);
    }
    const parents = new Set<string>();
    for (const tuple of tuples) {
      const parentId = tuple.parentConfig?.configurable?.["checkpoint_id"];
      if (typeof parentId === "string") {
        parents.add(parentId);
      }
    }
    const leaves = tuples.filter((tuple) => {
      const id = tuple.config.configurable?.["checkpoint_id"];
      return typeof id === "string" && !parents.has(id);
    });
    if (leaves.length === 0) {
      return this.delegate.getTuple(config);
    }
    const head = leaves.sort((left, right) =>
      String(right.config.configurable?.["checkpoint_id"]).localeCompare(
        String(left.config.configurable?.["checkpoint_id"]),
      ),
    )[0];
    // Hydrate through the explicit-id path so pending writes load exactly like a
    // resume read, and fall back to the delegate's own resolution if the leaf
    // cannot be read back (defensive).
    const hydrated = head ? await this.delegate.getTuple(head.config) : undefined;
    return hydrated ?? this.delegate.getTuple(config);
  }

  override list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    return this.delegate.list(config, options);
  }

  override getNextVersion(current: number | undefined): number {
    return this.delegate.getNextVersion(current);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    return this.gated(() => this.delegate.put(config, checkpoint, metadata, newVersions));
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    return this.gated(() => this.delegate.putWrites(config, writes, taskId));
  }

  override async deleteThread(threadId: string): Promise<void> {
    return this.delegate.deleteThread(threadId);
  }

  private async gated<T>(write: () => Promise<T>): Promise<T> {
    const client = await this.guardPool.connect();
    try {
      await client.query("BEGIN");
      await acquireCheckpointGate(client, this.ctx.tripId);
      const ownership = await readOperationOwnership(client, this.ctx.operationId);
      assertFencingCurrent(ownership, this.ctx);
      const result = await write();
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
  }
}
