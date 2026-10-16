/**
 * Graceful shutdown controller (02-architecture.md section 6).
 *
 * A shutdown request stops claims, aborts in-flight work through an
 * `AbortSignal`, and lets the driver wait up to the grace window for current
 * invocations to finish. Unfinished operations stay recoverable by lease expiry.
 */

export interface ShutdownController {
  readonly signal: AbortSignal;
  readonly isStopping: boolean;
  requestStop(reason?: string): void;
  /** Mark the start of an invocation; returns a release function. */
  enter(): () => void;
  /** Resolve when in-flight work is drained or the grace window elapses. */
  waitForIdle(graceMs: number): Promise<boolean>;
}

export function createShutdownController(graceMs = 30_000): ShutdownController {
  const abort = new AbortController();
  let stopping = false;
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  function requestStop(reason?: string): void {
    if (stopping) {
      return;
    }
    stopping = true;
    abort.abort(new Error(reason ?? "worker shutdown"));
  }

  function enter(): () => void {
    inFlight += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      inFlight -= 1;
      if (inFlight === 0) {
        for (const resolve of waiters.splice(0)) {
          resolve();
        }
      }
    };
  }

  async function waitForIdle(grace: number): Promise<boolean> {
    if (inFlight === 0) {
      return true;
    }
    const effective = Math.min(grace, graceMs);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), effective);
      timer.unref();
      waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  return {
    signal: abort.signal,
    get isStopping() {
      return stopping;
    },
    requestStop,
    enter,
    waitForIdle,
  };
}
