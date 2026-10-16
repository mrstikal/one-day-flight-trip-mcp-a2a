import { createHash } from "node:crypto";

/**
 * Canonical, versioned fingerprinting: SHA-256 of sorted-key canonical JSON
 * (04-domain-model.md section 1). The same logical input yields the same digest
 * regardless of object key order.
 */

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
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = canonicalize(entry);
      }
    }
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("cannot fingerprint non-finite numbers");
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`cannot fingerprint value of type ${typeof value}`);
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
