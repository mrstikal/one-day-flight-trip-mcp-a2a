"use client";

import { useEffect, useState } from "react";

/**
 * SSE projection wake-up. The stream is an enhancement: the caller still polls
 * while work is active and refreshes explicitly after each user action, so a
 * blocked or unsupported stream degrades to polling.
 *
 * The server emits *named* events (`event: decision.awaiting`, ...), so a plain
 * `onmessage` handler would never fire. We subscribe to the concrete event names
 * the worker writes; unknown future types still arrive via polling.
 *
 * Phase 11 hardening: events carry their monotonic id, and a reconnect can
 * replay rows we already applied. Duplicates are dropped by id before the
 * refresh callback fires, so a replayed stream never double-applies state.
 */
const PROJECTION_EVENTS = [
  "operation.admitted",
  "operation.succeeded",
  "operation.failed",
  "operation.requeued",
  "operation.retry_requested",
  "decision.admitted",
  "decision.awaiting",
  "decision.resolved",
  "booking.confirmed",
  "booking.cancelled",
  "trip.route_changed",
  "trip.preferences_changed",
  "trip.simulation_armed",
  "route_change.committed",
  "node.started",
  "node.updated",
  "conversation.message_added",
  "program.saved",
  "itinerary.attempt_started",
  "itinerary.attempt_finished",
  "itinerary.review_started",
  "itinerary.reviewed",
] as const;

/** Bounded dedupe window: ids are monotonic, so only recent ones need keeping. */
const SEEN_ID_LIMIT = 512;

export function useTripEvents(
  tripId: string,
  onEvent: () => void,
): { readonly supported: boolean; readonly reconnecting: boolean } {
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return undefined;
    }
    const source = new EventSource(`/api/trips/${tripId}/events`);
    const seenIds: string[] = [];
    const seen = new Set<string>();
    const fire = (event: MessageEvent): void => {
      const id = event.lastEventId;
      if (typeof id === "string" && id.length > 0) {
        if (seen.has(id)) {
          return;
        }
        seen.add(id);
        seenIds.push(id);
        if (seenIds.length > SEEN_ID_LIMIT) {
          const dropped = seenIds.shift();
          if (dropped !== undefined) {
            seen.delete(dropped);
          }
        }
      }
      onEvent();
    };
    for (const type of PROJECTION_EVENTS) {
      source.addEventListener(type, fire as EventListener);
    }
    source.addEventListener("message", fire as EventListener);
    source.addEventListener("open", () => setReconnecting(false));
    source.addEventListener("error", () => {
      // The browser reconnects EventSource automatically and resends
      // `Last-Event-ID`; polling covers the gap and dedupe covers the replay.
      setReconnecting(true);
    });
    return () => source.close();
  }, [tripId, onEvent]);

  return {
    supported: typeof window !== "undefined" && typeof EventSource !== "undefined",
    reconnecting,
  };
}
