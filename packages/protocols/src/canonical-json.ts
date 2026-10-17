import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization for payload hashing.
 *
 * Object keys are sorted recursively; array order is preserved (it is
 * meaningful in A2A messages and artifact lists). Used for inbound message
 * dedupe hashes and outbound payload hashes so the same logical payload always
 * produces the same hash regardless of producer key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      // Byte order: hashes must never depend on the runtime locale/ICU data.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entryValue]) => [key, sortValue(entryValue)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
