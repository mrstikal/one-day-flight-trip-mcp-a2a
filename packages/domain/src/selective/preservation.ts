import type { BookableKey, ResearchDomain } from "@odft/contracts";
import type { InvalidationChange, InvalidationRefs } from "./fingerprint-scope.js";

/**
 * Phase 11 preservation helpers (03-langgraph-design.md section 10, T-INV-04/07).
 *
 * These functions name what a selective change must NOT touch, so graph routing
 * and tests can assert the preservation invariant instead of trusting wording:
 * confirmed reservations change only through explicit decisions, and unrelated
 * scenario content hashes stay identical.
 */

/** Confirmed services whose reservation IDs a change must keep. */
export function preservedReservationServices(change: InvalidationChange): BookableKey[] {
  switch (change.kind) {
    case "hotel_level":
    case "selected_hotel_replacement":
      return ["flights", "breakfast", "lunch", "dinner"];
    case "search_alternatives":
      return change.target === "hotel"
        ? ["flights", "breakfast", "lunch", "dinner"]
        : ["flights", "hotel"];
    case "meal_level":
    case "selected_meal_replacement":
      return ["flights", "hotel"];
    case "activity_pace":
    case "interests":
    case "activity_requirement":
    case "budget":
      return ["flights", "hotel", "breakfast", "lunch", "dinner"];
    default:
      return [];
  }
}

/**
 * Domains whose scenario content hashes a change must not alter. Route changes
 * and replacements legitimately extend/refresh their own domain, so they are
 * excluded from the "preserved content" claim here; the concrete hash check is
 * `checkPreservation`.
 */
export function preservedContentDomains(change: InvalidationChange): ResearchDomain[] {
  switch (change.kind) {
    case "hotel_level":
    case "selected_hotel_replacement":
      return ["breakfast", "lunch", "dinner", "attractions", "events"];
    case "meal_level":
    case "selected_meal_replacement": {
      const all: ResearchDomain[] = ["hotel", "breakfast", "lunch", "dinner", "attractions", "events"];
      return all.filter((domain) => domain !== change.meal);
    }
    case "activity_pace":
      return ["hotel", "breakfast", "lunch", "dinner", "attractions", "events"];
    case "interests":
    case "activity_requirement":
      return ["hotel", "breakfast", "lunch", "dinner", "events"];
    default:
      return [];
  }
}

export interface ContentHashSnapshot {
  readonly domain: ResearchDomain;
  readonly contentHash: string;
}

export interface PreservationCheckInput {
  readonly change: InvalidationChange;
  readonly refs: InvalidationRefs;
  readonly before: readonly ContentHashSnapshot[];
  readonly after: readonly ContentHashSnapshot[];
  readonly beforeReservationIds: Readonly<Record<string, string>>;
  readonly afterReservationIds: Readonly<Record<string, string>>;
}

export interface PreservationViolation {
  readonly kind: "content_hash_changed" | "reservation_changed";
  readonly key: string;
  readonly message: string;
}

/**
 * Deterministic preservation assertion used by invariant tests (T-INV-07):
 * every domain outside the affected set keeps its content hash, and every
 * preserved service keeps its exact reservation id.
 */
export function checkPreservation(input: PreservationCheckInput): PreservationViolation[] {
  const violations: PreservationViolation[] = [];
  const preservedDomains = new Set(preservedContentDomains(input.change));
  const beforeByDomain = new Map(input.before.map((entry) => [entry.domain, entry.contentHash]));
  for (const entry of input.after) {
    if (!preservedDomains.has(entry.domain)) {
      continue;
    }
    const previous = beforeByDomain.get(entry.domain);
    if (previous !== undefined && previous !== entry.contentHash) {
      violations.push({
        kind: "content_hash_changed",
        key: entry.domain,
        message: `${entry.domain} content hash changed by a ${input.change.kind} change`,
      });
    }
  }
  for (const service of preservedReservationServices(input.change)) {
    const before = input.beforeReservationIds[service];
    const after = input.afterReservationIds[service];
    if (before !== undefined && after !== before) {
      violations.push({
        kind: "reservation_changed",
        key: service,
        message: `${service} reservation changed by a ${input.change.kind} change`,
      });
    }
  }
  return violations;
}
