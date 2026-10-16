import { describe, expect, it } from "vitest";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { FencedSaver } from "../../apps/worker/src/checkpointer/fenced-saver.js";
import type { OperationFencingContext } from "@odft/persistence";

/**
 * Checkpoint-ID ordering guard (2026-10-13): the upstream id generator keeps its
 * monotonic clock per module instance (ESM vs CJS builds), so ids written within
 * one run can sort backwards. `ORDER BY checkpoint_id DESC` then returns a
 * checkpoint from the middle of the run; FencedSaver must resolve the causal leaf
 * instead (the newest checkpoint that no other checkpoint names as its parent).
 */

interface FakeTuple {
  readonly id: string;
  readonly parentId: string | null;
}

function tuple(input: FakeTuple): CheckpointTuple {
  return {
    config: { configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: input.id } },
    checkpoint: { id: input.id } as Checkpoint,
    metadata: { source: "loop", step: 0, parents: {} },
    ...(input.parentId
      ? {
          parentConfig: {
            configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: input.parentId },
          },
        }
      : {}),
    pendingWrites: [],
  };
}

/** Mimics the official saver: head = max id string; explicit ids are exact reads. */
class FakeSaver extends BaseCheckpointSaver {
  private readonly tuples: CheckpointTuple[];

  constructor(rows: readonly FakeTuple[]) {
    super();
    this.tuples = rows
      .map(tuple)
      .sort((left, right) =>
        String(right.config.configurable?.["checkpoint_id"]).localeCompare(
          String(left.config.configurable?.["checkpoint_id"]),
        ),
      );
  }

  override async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
    return (await this.getTuple(config))?.checkpoint;
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const id = config.configurable?.["checkpoint_id"];
    if (typeof id === "string") {
      return this.tuples.find((entry) => entry.config.configurable?.["checkpoint_id"] === id);
    }
    return this.tuples[0];
  }

  override async *list(): AsyncGenerator<CheckpointTuple> {
    yield* this.tuples;
  }

  override async put(): Promise<RunnableConfig> {
    throw new Error("unused in this test");
  }

  override async putWrites(): Promise<void> {}

  override async deleteThread(): Promise<void> {}

  override getNextVersion(current: number | undefined): number {
    return (current ?? 0) + 1;
  }
}

const ctx: OperationFencingContext = {
  tripId: "t",
  operationId: "o",
  fencingToken: "1",
};

function saverFor(rows: readonly FakeTuple[]): FencedSaver {
  return new FencedSaver(new FakeSaver(rows), null as never, ctx);
}

const headId = async (saver: FencedSaver): Promise<string | undefined> => {
  const head = await saver.getTuple({
    configurable: { thread_id: "t", checkpoint_ns: "" },
  } as RunnableConfig);
  return head?.config.configurable?.["checkpoint_id"];
};

describe("FencedSaver head resolution", () => {
  it("returns the causal leaf when a broken id sorts the newest", async () => {
    // input(3) -> s0(5) -> s1(9) -> s2(4) -> s3(6): max id is the MIDDLE node.
    const saver = saverFor([
      { id: "0003", parentId: null },
      { id: "0005", parentId: "0003" },
      { id: "0009", parentId: "0005" },
      { id: "0004", parentId: "0009" },
      { id: "0006", parentId: "0004" },
    ]);
    expect(await headId(saver)).toBe("0006");
  });

  it("still prefers the newest id among several leaves (branched history)", async () => {
    const saver = saverFor([
      { id: "0001", parentId: null },
      { id: "0005", parentId: "0001" },
      { id: "0009", parentId: "0005" },
      { id: "0003", parentId: "0001" },
      { id: "0007", parentId: "0003" },
    ]);
    expect(await headId(saver)).toBe("0009");
  });

  it("keeps monotonic threads on the same tuple as the library", async () => {
    const saver = saverFor([
      { id: "0001", parentId: null },
      { id: "0002", parentId: "0001" },
      { id: "0003", parentId: "0002" },
    ]);
    expect(await headId(saver)).toBe("0003");
  });

  it("never rewrites explicit checkpoint_id reads", async () => {
    const saver = saverFor([
      { id: "0003", parentId: null },
      { id: "0005", parentId: "0003" },
      { id: "0009", parentId: "0005" },
      { id: "0004", parentId: "0009" },
    ]);
    const explicit = await saver.getTuple({
      configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "0009" },
    } as RunnableConfig);
    expect(explicit?.config.configurable?.["checkpoint_id"]).toBe("0009");
  });
});