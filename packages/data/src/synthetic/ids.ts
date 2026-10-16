import { createHash } from "node:crypto";

/**
 * Stable offer/entity IDs (05-synthetic-data-design.md section 7).
 *
 * IDs derive from stable scenario/domain/index content, never from a per-read
 * random UUID, so the same scenario/version yields repeatable identities.
 */

const SHORT = 16;

function digest(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, SHORT);
}

export function deriveOfferId(
  scenarioKey: string,
  domain: string,
  index: number,
  discriminator?: string,
): string {
  const suffix = discriminator ? `:${discriminator}` : "";
  return `demo-${domain}-${digest([scenarioKey, domain, String(index) + suffix])}`;
}

export function deriveEntityId(
  scenarioKey: string,
  domain: string,
  index: number,
  discriminator?: string,
): string {
  return deriveOfferId(scenarioKey, domain, index, discriminator);
}
