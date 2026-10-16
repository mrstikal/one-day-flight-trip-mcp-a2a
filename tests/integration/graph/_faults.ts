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

/**
 * Test fault injection: a saver that fails the first N checkpoint `put` calls to
 * simulate a crash after domain effects commit but before the checkpoint write
 * (commit-before-checkpoint).
 */
export class FailOnceSaver extends BaseCheckpointSaver {
  private remaining: number;
  private skip: number;

  constructor(
    private readonly delegate: BaseCheckpointSaver,
    times = 1,
    skip = 0,
  ) {
    super(delegate.serde);
    this.remaining = times;
    this.skip = skip;
  }

  override async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
    return this.delegate.get(config);
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.delegate.getTuple(config);
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
    if (this.skip > 0) {
      this.skip -= 1;
      return this.delegate.put(config, checkpoint, metadata, newVersions);
    }
    if (this.remaining > 0) {
      this.remaining -= 1;
      throw new Error("simulated checkpoint write failure");
    }
    return this.delegate.put(config, checkpoint, metadata, newVersions);
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    return this.delegate.putWrites(config, writes, taskId);
  }

  override async deleteThread(threadId: string): Promise<void> {
    return this.delegate.deleteThread(threadId);
  }
}
