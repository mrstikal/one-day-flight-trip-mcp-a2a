/**
 * Bounded, tagged provider results (05 section 11). Interfaces depend on domain
 * contracts only; a future real provider can implement them without changing
 * graph routing.
 */

import type { SnapshotContent } from "@odft/contracts";

/** Read-only view over persisted snapshots, implemented by `@odft/persistence`. */
export interface SnapshotSource {
  getContent(snapshotId: string): Promise<SnapshotContent | undefined>;
}

export type ProviderStatus = "ok" | "unavailable" | "retryable_error" | "unsupported";

export type ProviderResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "retryable_error"; readonly reason: string }
  | { readonly status: "unsupported"; readonly reason: string };

export function ok<T>(value: T): ProviderResult<T> {
  return { status: "ok", value };
}

export function unavailable<T = never>(reason: string): ProviderResult<T> {
  return { status: "unavailable", reason };
}

export function retryableError<T = never>(reason: string): ProviderResult<T> {
  return { status: "retryable_error", reason };
}

export function unsupported<T = never>(reason: string): ProviderResult<T> {
  return { status: "unsupported", reason };
}

export function isOk<T>(result: ProviderResult<T>): result is { status: "ok"; value: T } {
  return result.status === "ok";
}
