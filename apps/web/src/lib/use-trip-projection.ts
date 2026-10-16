"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TripProjection } from "@odft/contracts";
import { ApiError, apiGet } from "./api-client";
import { operationPreloader } from "./operation-preloader";

const POLL_INTERVAL_MS = 1500;
const MAX_BACKOFF_MS = 10_000;

interface ProjectionState {
  readonly projection: TripProjection | null;
  readonly error: ApiError | null;
  readonly loading: boolean;
}

function hasActiveWork(projection: TripProjection): boolean {
  return (
    projection.operations.some(
      (operation) => operation.status === "queued" || operation.status === "running",
    ) || projection.pendingDecision !== null
  );
}

/**
 * Own projection reader. Polls while the worker has active work or a decision is
 * pending, and refetches on demand (after a resume or an SSE event). A transient
 * fetch failure does not stop polling: it retries with capped backoff and keeps
 * the last projection visible while surfacing the error. Pass `poll: false` for
 * a secondary reader (e.g. the step nav) that refetches only on SSE events, so
 * one page never runs several polling loops.
 */
export function useTripProjection(
  tripId: string,
  options: { readonly poll?: boolean } = {},
): ProjectionState & {
  readonly refresh: () => void;
} {
  const [state, setState] = useState<ProjectionState>({
    projection: null,
    error: null,
    loading: true,
  });
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const failures = useRef(0);
  const loadRef = useRef<() => void>(() => {});

  const schedule = useCallback((delay: number) => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      loadRef.current();
    }, delay);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const projection = await apiGet<TripProjection>(`/api/trips/${tripId}`);
      if (!mounted.current) {
        return;
      }
      failures.current = 0;
      operationPreloader.reconcileOperations(projection.operations);
      setState({ projection, error: null, loading: false });
      if (options.poll !== false && hasActiveWork(projection)) {
        schedule(POLL_INTERVAL_MS);
      }
    } catch (error) {
      if (!mounted.current) {
        return;
      }
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              code: "NETWORK_ERROR",
              message: "Could not reach the server; retrying…",
              status: 0,
              retryable: true,
            });
      setState((previous) => ({
        projection: previous.projection,
        error: apiError,
        loading: false,
      }));
      // Keep trying: an unreachable server or a dropped SSE must not freeze the view.
      failures.current += 1;
      schedule(Math.min(POLL_INTERVAL_MS * 2 ** Math.min(failures.current, 4), MAX_BACKOFF_MS));
    } finally {
      inFlight.current = false;
    }
  }, [options.poll, schedule, tripId]);

  useEffect(() => {
    loadRef.current = () => {
      void load();
    };
  }, [load]);

  const refresh = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    loadRef.current();
  }, []);

  useEffect(() => {
    mounted.current = true;
    loadRef.current();
    return () => {
      mounted.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, []);

  return { ...state, refresh };
}
