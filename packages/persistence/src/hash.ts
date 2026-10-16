import { createHash } from "node:crypto";

/** Canonical JSON + SHA-256 for admission payload hashes (persistence-local). */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        sorted[key] = canonicalize(record[key]);
      }
    }
    return sorted;
  }
  // Match @odft/domain fingerprint semantics: reject values JSON would silently alter.
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("cannot fingerprint non-finite numbers");
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`cannot fingerprint value of type ${typeof value}`);
  }
  return value;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
