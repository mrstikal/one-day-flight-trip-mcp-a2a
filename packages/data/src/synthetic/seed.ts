import { createHash } from "node:crypto";
import { Faker, en } from "@faker-js/faker";
import type { ScenarioDomain } from "@odft/contracts";

/**
 * Deterministic seed derivation (05-synthetic-data-design.md section 7).
 *
 * Independent per-domain streams derive from `hash(seed, scenarioKey, domain,
 * domainVersion)`. A fresh Faker instance is created per stream; the global
 * singleton is never reseeded, so parallel domain work cannot interfere.
 */

const UINT32 = 0xffffffff;

/** Stable 32-bit words derived from an arbitrary string (for `faker.seed`). */
export function seedWords(seed: string): number[] {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const words: number[] = [];
  for (let index = 0; index + 4 <= digest.length; index += 4) {
    words.push(digest.readUInt32BE(index) & UINT32);
  }
  return words;
}

function domainSeedString(
  seed: string,
  scenarioKey: string,
  domain: ScenarioDomain,
  domainVersion: string,
): string {
  return [seed, scenarioKey, domain, domainVersion].join("\u0000");
}

/** `hash(seed, scenarioKey, domain, domainVersion)` as a hex digest. */
export function deriveDomainSeed(
  seed: string,
  scenarioKey: string,
  domain: ScenarioDomain,
  domainVersion: string,
): string {
  return createHash("sha256")
    .update(domainSeedString(seed, scenarioKey, domain, domainVersion), "utf8")
    .digest("hex");
}

/** A dedicated, deterministically seeded Faker instance for one domain stream. */
export function createDomainFaker(
  seed: string,
  scenarioKey: string,
  domain: ScenarioDomain,
  domainVersion: string,
): Faker {
  const faker = new Faker({ locale: [en] });
  faker.seed(seedWords(domainSeedString(seed, scenarioKey, domain, domainVersion)));
  return faker;
}
