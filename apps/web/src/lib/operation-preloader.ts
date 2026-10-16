import type { OperationStatusResponse } from "@odft/contracts";

export const OPERATION_PRELOADER_DELAY_MS = 500;

interface ActiveOperation {
  readonly message: string;
  readonly startedAt: number;
}

interface ProjectedOperationStatus {
  readonly operationId: string;
  readonly status: string;
  readonly progress?: OperationStatusResponse["progress"];
}

export function operationProgressMessage(
  operation: ProjectedOperationStatus,
  fallback: string,
): string {
  const progress = operation.progress;
  if (!progress) {
    return fallback;
  }
  const saved = progress.programSaved ? "Meal selections saved. " : "";
  switch (progress.stage) {
    case "program_saved":
      return "Meal selections saved. Checking your plan...";
    case "planning_itinerary":
      return `${saved}Building your itinerary...`;
    case "reviewing_itinerary":
      return `${saved}Reviewing your itinerary...`;
  }
}

/**
 * Tracks user-initiated requests and exposes the most recent request that has
 * exceeded the display delay.
 */
export class OperationPreloader {
  private readonly activeOperations = new Map<number, ActiveOperation>();
  private readonly listeners = new Set<() => void>();
  private readonly trackedOperations = new Map<string, string>();
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private message: string | null = null;
  private blocking = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): string | null => this.message;
  getBlockingSnapshot = (): boolean => this.blocking;

  start(message: string): () => void {
    const id = this.nextId;
    this.nextId += 1;
    this.activeOperations.set(id, { message, startedAt: Date.now() });
    this.update();

    return () => {
      if (this.activeOperations.delete(id)) {
        this.update();
      }
    };
  }

  /**
   * Keep accepted work blocking until its projected status settles.
   */
  trackAcceptedOperation(operationId: string, message: string): void {
    if (this.trackedOperations.has(operationId)) {
      return;
    }
    this.trackedOperations.set(operationId, message);
    this.update();
  }

  reconcileOperations(operations: readonly ProjectedOperationStatus[]): void {
    for (const operation of operations) {
      if (operation.status !== "queued" && operation.status !== "running") {
        this.trackedOperations.delete(operation.operationId);
      } else {
        const message =
          this.trackedOperations.get(operation.operationId) ?? "Preparing your plan...";
        this.trackedOperations.set(
          operation.operationId,
          operationProgressMessage(operation, message),
        );
      }
    }
    this.update();
  }

  private update(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    const now = Date.now();
    const eligible = [...this.activeOperations.values()].filter(
      (operation) => now - operation.startedAt >= OPERATION_PRELOADER_DELAY_MS,
    );
    const nextMessage =
      eligible.at(-1)?.message ?? [...this.trackedOperations.values()].at(-1) ?? null;
    const nextBlocking = this.activeOperations.size > 0 || this.trackedOperations.size > 0;

    if (this.message !== nextMessage || this.blocking !== nextBlocking) {
      this.message = nextMessage;
      this.blocking = nextBlocking;
      for (const listener of this.listeners) {
        listener();
      }
    }

    const nextVisibleAt = [...this.activeOperations.values()]
      .filter((operation) => now - operation.startedAt < OPERATION_PRELOADER_DELAY_MS)
      .reduce<number | null>(
        (earliest, operation) =>
          earliest === null
            ? operation.startedAt + OPERATION_PRELOADER_DELAY_MS
            : Math.min(earliest, operation.startedAt + OPERATION_PRELOADER_DELAY_MS),
        null,
      );

    if (nextVisibleAt !== null) {
      this.timeout = setTimeout(() => this.update(), Math.max(0, nextVisibleAt - now));
    }
  }
}

export const operationPreloader = new OperationPreloader();

export async function runWithOperationPreloader<T>(
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  const finish = operationPreloader.start(message);
  try {
    return await operation();
  } finally {
    finish();
  }
}
