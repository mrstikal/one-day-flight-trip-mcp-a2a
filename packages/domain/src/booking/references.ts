import { randomBytes } from "node:crypto";
import { demoReferencePrefixes, type BookableKey } from "@odft/contracts";

/**
 * Demo reservation reference generation (09-booking-simulation.md section 3).
 * Format: `DEMO-FLT-` / `DEMO-HTL-` / `DEMO-RST-` + 20 uppercase hex characters
 * (80 random bits). A reference is display-only — never authorization.
 */

export const DEMO_REFERENCE_PATTERN = /^DEMO-(FLT|HTL|RST)-[0-9A-F]{20}$/;
export const DEMO_REFERENCE_ATTEMPTS = 3;

export function demoReferencePrefix(service: BookableKey): string {
  const prefix = demoReferencePrefixes[service];
  if (!prefix) {
    throw new Error(`No demo reference prefix registered for service ${service}`);
  }
  return prefix;
}

/** Deterministic when a `randomHex` source is injected (used to force collisions in tests). */
export function generateDemoReference(
  service: BookableKey,
  randomHex: () => string = () => randomBytes(10).toString("hex"),
): string {
  return demoReferencePrefix(service) + randomHex().toUpperCase();
}

export function isDemoReference(value: string): boolean {
  return DEMO_REFERENCE_PATTERN.test(value);
}
