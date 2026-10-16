/**
 * Deterministic, offline search-key normalization and ranking helpers used by
 * the reference lookups. No network, no locale-dependent collation.
 */

import type { CoverageFlag } from "./types.js";

/** Fold diacritics, lowercase, and collapse whitespace into a stable search key. */
export function normalizeSearchKey(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * OurAirports types accepted as passenger origins: closed, heliport, seaplane,
 * balloon, and unknown/small types are rejected.
 */
export const ORIGIN_CANDIDATE_TYPES: ReadonlySet<string> = new Set([
  "large_airport",
  "medium_airport",
]);

export function isOriginCandidateType(type: string): boolean {
  return ORIGIN_CANDIDATE_TYPES.has(type);
}

/** Exactly one coverage flag per city. */
export function deriveCityCoverage(isCurated: boolean, zone: string): CoverageFlag {
  if (isCurated) {
    return "curated_landmarks";
  }
  return zone.length === 0 || zone.startsWith("Etc/") ? "insufficient_reference" : "generic_only";
}

export interface Rankable {
  readonly name: string;
  readonly searchKey: string;
  readonly population?: number;
}

/**
 * Rank items whose normalized search key contains the query. Prefix matches sort
 * before infix matches; ties break by population (desc) then name (asc), so the
 * ordering is fully deterministic.
 */
export function rankByQuery<T extends Rankable>(items: readonly T[], query: string): T[] {
  const needle = normalizeSearchKey(query);
  if (needle.length === 0) {
    return [...items];
  }
  const scored: { item: T; tier: number }[] = [];
  for (const item of items) {
    const index = item.searchKey.indexOf(needle);
    if (index === -1) {
      continue;
    }
    scored.push({ item, tier: index === 0 ? 0 : 1 });
  }
  scored.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    const popA = a.item.population ?? 0;
    const popB = b.item.population ?? 0;
    if (popA !== popB) {
      return popB - popA;
    }
    return a.item.name.localeCompare(b.item.name);
  });
  return scored.map((entry) => entry.item);
}

export interface Paginated<T> {
  readonly items: T[];
  readonly nextCursor?: string;
}

/** Offset-based pagination with an opaque numeric cursor. */
export function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number): Paginated<T> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const slice = items.slice(start, start + safeLimit);
  const nextIndex = start + slice.length;
  const nextCursor = nextIndex < items.length ? String(nextIndex) : undefined;
  return nextCursor ? { items: slice, nextCursor } : { items: slice };
}
