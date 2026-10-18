import { describe, expect, it, vi } from "vitest";
import { AgentConcurrencyGate, AgentSaturationError, withAgentConcurrency } from "@odft/protocols";

/**
 * Plan §3.9: each agent runs at most two tasks concurrently with a bounded
 * queue; saturation is rejected with the retryable AGENT_UNAVAILABLE code.
 */
describe("agent concurrency gate", () => {
  it("runs two tasks and queues the rest", async () => {
    const gate = new AgentConcurrencyGate({ concurrency: 2, queueLimit: 2 });
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run = (): Promise<void> =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      });

    const tasks = [run(), run(), run(), run()];
    expect(active).toBe(2);
    // Release the two running tasks; the two queued ones take their slots.
    releases[0]?.();
    releases[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(2);
    releases[2]?.();
    releases[3]?.();
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });

  it("settles the durable task row when saturation rejects it", async () => {
    const gate = new AgentConcurrencyGate({ concurrency: 1, queueLimit: 0 });
    let release: (() => void) | undefined;
    const running = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const onSaturation = vi.fn(async () => undefined);
    const executor = withAgentConcurrency(
      {
        execute: async () => undefined,
        cancelTask: async () => undefined,
      },
      gate,
      onSaturation,
    );
    await expect(
      executor.execute({ taskId: "task-saturated" } as never, {} as never),
    ).rejects.toBeInstanceOf(AgentSaturationError);
    expect(onSaturation).toHaveBeenCalledWith("task-saturated");
    release?.();
    await running;
  });

  it("rejects saturation with a retryable safe code", async () => {
    const gate = new AgentConcurrencyGate({ concurrency: 1, queueLimit: 1 });
    let release: (() => void) | undefined;
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const second = gate.run(async () => undefined);
    await expect(gate.run(async () => undefined)).rejects.toBeInstanceOf(AgentSaturationError);
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    release?.();
    await first;
    await second;
  });
});
