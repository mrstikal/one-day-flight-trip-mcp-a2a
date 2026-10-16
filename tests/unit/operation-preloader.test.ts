import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPERATION_PRELOADER_DELAY_MS,
  OperationPreloader,
} from "../../apps/web/src/lib/operation-preloader.js";

describe("OperationPreloader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("remains hidden until an operation exceeds 500 ms", () => {
    const preloader = new OperationPreloader();
    const finish = preloader.start("Saving your plan...");
    expect(preloader.getBlockingSnapshot()).toBe(true);

    vi.advanceTimersByTime(OPERATION_PRELOADER_DELAY_MS - 1);
    expect(preloader.getSnapshot()).toBeNull();

    vi.advanceTimersByTime(1);
    expect(preloader.getSnapshot()).toBe("Saving your plan...");

    finish();
    expect(preloader.getSnapshot()).toBeNull();
    expect(preloader.getBlockingSnapshot()).toBe(false);
  });

  it("only shows an overlapping action after that action reaches the delay", () => {
    const preloader = new OperationPreloader();
    const finishFirst = preloader.start("Loading city data...");

    vi.advanceTimersByTime(OPERATION_PRELOADER_DELAY_MS);
    expect(preloader.getSnapshot()).toBe("Loading city data...");

    const finishSecond = preloader.start("Waiting for the AI assistant's response...");
    finishFirst();
    expect(preloader.getSnapshot()).toBeNull();

    vi.advanceTimersByTime(OPERATION_PRELOADER_DELAY_MS - 1);
    expect(preloader.getSnapshot()).toBeNull();

    vi.advanceTimersByTime(1);
    expect(preloader.getSnapshot()).toBe("Waiting for the AI assistant's response...");

    finishSecond();
    expect(preloader.getSnapshot()).toBeNull();
  });

  it("keeps accepted work blocking until its projected status settles", () => {
    const preloader = new OperationPreloader();
    preloader.trackAcceptedOperation("operation-1", "Saving your plan...");

    vi.advanceTimersByTime(OPERATION_PRELOADER_DELAY_MS);
    expect(preloader.getSnapshot()).toBe("Saving your plan...");
    expect(preloader.getBlockingSnapshot()).toBe(true);

    preloader.reconcileOperations([{ operationId: "operation-1", status: "running" }]);
    expect(preloader.getSnapshot()).toBe("Saving your plan...");
    expect(preloader.getBlockingSnapshot()).toBe(true);

    preloader.reconcileOperations([{ operationId: "operation-1", status: "waiting" }]);
    expect(preloader.getSnapshot()).toBeNull();
    expect(preloader.getBlockingSnapshot()).toBe(false);
  });

  it("does not claim selections are saved until the projection confirms persistence", () => {
    const preloader = new OperationPreloader();
    preloader.trackAcceptedOperation("operation-1", "Request accepted.");
    expect(preloader.getSnapshot()).toBe("Request accepted.");
    preloader.reconcileOperations([
      {
        operationId: "operation-1",
        status: "running",
        progress: { stage: "planning_itinerary", programSaved: true },
      },
    ]);
    expect(preloader.getSnapshot()).toBe("Meal selections saved. Building your itinerary...");
    preloader.reconcileOperations([
      {
        operationId: "operation-1",
        status: "running",
        progress: { stage: "reviewing_itinerary", programSaved: true },
      },
    ]);
    expect(preloader.getSnapshot()).toBe("Meal selections saved. Reviewing your itinerary...");
    preloader.reconcileOperations([{ operationId: "operation-1", status: "failed" }]);
    expect(preloader.getSnapshot()).toBeNull();
    expect(preloader.getBlockingSnapshot()).toBe(false);
  });

  it("continues blocking accepted work after an overlapping HTTP request finishes", () => {
    const preloader = new OperationPreloader();
    preloader.trackAcceptedOperation("operation-1", "Request accepted.");
    const finish = preloader.start("Sending another request...");
    vi.advanceTimersByTime(OPERATION_PRELOADER_DELAY_MS);
    expect(preloader.getSnapshot()).toBe("Sending another request...");
    expect(preloader.getBlockingSnapshot()).toBe(true);
    finish();
    expect(preloader.getSnapshot()).toBe("Request accepted.");
    expect(preloader.getBlockingSnapshot()).toBe(true);
    preloader.reconcileOperations([{ operationId: "operation-1", status: "waiting" }]);
    expect(preloader.getSnapshot()).toBeNull();
    expect(preloader.getBlockingSnapshot()).toBe(false);
  });

  it("does not unlock between HTTP acceptance and the first fresh projection", () => {
    const preloader = new OperationPreloader();
    const finish = preloader.start("Saving your plan...");
    preloader.trackAcceptedOperation("operation-1", "Request accepted.");
    finish();
    preloader.reconcileOperations([]);
    expect(preloader.getSnapshot()).toBe("Request accepted.");
    expect(preloader.getBlockingSnapshot()).toBe(true);
    preloader.reconcileOperations([{ operationId: "operation-1", status: "waiting" }]);
    expect(preloader.getBlockingSnapshot()).toBe(false);
  });

  it("restores blocking progress from active work after a reload", () => {
    const preloader = new OperationPreloader();
    preloader.reconcileOperations([
      {
        operationId: "operation-1",
        status: "running",
        progress: { stage: "reviewing_itinerary", programSaved: true },
      },
    ]);
    expect(preloader.getSnapshot()).toBe("Meal selections saved. Reviewing your itinerary...");
    expect(preloader.getBlockingSnapshot()).toBe(true);
    preloader.reconcileOperations([{ operationId: "operation-1", status: "waiting" }]);
    expect(preloader.getBlockingSnapshot()).toBe(false);
  });

  it.each(["waiting", "succeeded", "failed", "cancelled"])(
    "unlocks when the operation becomes %s",
    (status) => {
      const preloader = new OperationPreloader();
      preloader.trackAcceptedOperation("operation-1", "Preparing your plan...");
      preloader.reconcileOperations([{ operationId: "operation-1", status }]);
      expect(preloader.getSnapshot()).toBeNull();
      expect(preloader.getBlockingSnapshot()).toBe(false);
    },
  );

  it("does not block ordinary projection reads without active work", () => {
    const preloader = new OperationPreloader();
    preloader.reconcileOperations([{ operationId: "operation-1", status: "waiting" }]);
    expect(preloader.getSnapshot()).toBeNull();
    expect(preloader.getBlockingSnapshot()).toBe(false);
  });
});
