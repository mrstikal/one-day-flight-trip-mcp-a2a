import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  airportRefSchema,
  cityAirportLinkSchema,
  cityRefSchema,
  countryRefSchema,
  landmarkSchema,
  loadCountryPolicy,
  manifestSchema,
  routeEvidenceSchema,
} from "@odft/data";

/** T-UT-REF-05 (FR-REF-5): manifest/license/checksum completeness and no runtime download. */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dataDir = `${repoRoot}data/reference`;
const manifestDir = `${repoRoot}data/manifests`;
const licensesDir = `${manifestDir}/licenses`;

async function readNdjson(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe("T-UT-REF-05 reference manifests and licensing", () => {
  it("every manifest is complete with a real SHA-256 and license", async () => {
    const names = (await readdir(manifestDir)).filter(
      (name) => name.endsWith(".json") && name !== "index.json",
    );
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(`${manifestDir}/${name}`, "utf8")));
      expect(manifest.sha256, name).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.sha256, name).not.toBe("0".repeat(64));
      expect(manifest.url.length, name).toBeGreaterThan(0);
      expect(manifest.transformVersion.length, name).toBeGreaterThan(0);
    }
  });

  it("recomputes the recorded SHA-256 for derived reference artifacts", async () => {
    async function sha256(path: string): Promise<string> {
      return createHash("sha256").update(await readFile(path)).digest("hex");
    }
    const manifest = async (name: string): Promise<{ sha256: string }> =>
      manifestSchema.parse(JSON.parse(await readFile(`${manifestDir}/${name}.json`, "utf8")));

    expect((await manifest("geo-tz")).sha256).toBe(await sha256(`${dataDir}/airports.ndjson`));
    expect((await manifest("wikidata-landmarks")).sha256).toBe(await sha256(`${dataDir}/landmarks.ndjson`));
    expect((await manifest("tz-boundary-odbl")).sha256).toBe(await sha256(`${licensesDir}/odbl-timezone.txt`));
  });

  it("commits the required license texts", async () => {
    const licenses = await readdir(licensesDir);
    expect(licenses).toEqual(expect.arrayContaining(["geonames-cc-by.txt", "odbl-timezone.txt"]));
    const geonames = await readFile(`${licensesDir}/geonames-cc-by.txt`, "utf8");
    expect(geonames).toMatch(/CC BY 4\.0/);
    const odbl = await readFile(`${licensesDir}/odbl-timezone.txt`, "utf8");
    expect(odbl).toMatch(/ODbL/i);
  });

  it("commits validated non-empty reference assets", async () => {
    expect((await readNdjson(`${dataDir}/countries.ndjson`)).map((r) => countryRefSchema.parse(r))).not.toHaveLength(0);
    expect((await readNdjson(`${dataDir}/cities.ndjson`)).map((r) => cityRefSchema.parse(r))).not.toHaveLength(0);
    expect((await readNdjson(`${dataDir}/airports.ndjson`)).map((r) => airportRefSchema.parse(r))).not.toHaveLength(0);
    expect((await readNdjson(`${dataDir}/city-airports.ndjson`)).map((r) => cityAirportLinkSchema.parse(r))).not.toHaveLength(0);
    expect((await readNdjson(`${dataDir}/landmarks.ndjson`)).map((r) => landmarkSchema.parse(r))).not.toHaveLength(0);
    expect((await readNdjson(`${dataDir}/route-evidence.ndjson`)).map((r) => routeEvidenceSchema.parse(r))).not.toHaveLength(0);
  });

  it("has at least eight verified landmarks per curated city", async () => {
    const policy = loadCountryPolicy();
    const cities = (await readNdjson(`${dataDir}/cities.ndjson`)).map((row) => cityRefSchema.parse(row));
    const landmarks = (await readNdjson(`${dataDir}/landmarks.ndjson`)).map((row) => landmarkSchema.parse(row));
    for (const curated of policy.curatedCities) {
      const city = cities.find(
        (candidate) =>
          candidate.countryKey === curated.countryKey &&
          candidate.name.toLowerCase() === curated.name.toLowerCase(),
      );
      expect(city, curated.name).toBeDefined();
      const count = landmarks.filter((landmark) => landmark.cityId === city?.id).length;
      expect(count, curated.name).toBeGreaterThanOrEqual(8);
    }
  });

  it("has no runtime download path in service code", async () => {
    const dirs = [`${repoRoot}packages/data/src`, `${repoRoot}packages/persistence/src`];
    const violations: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(full);
        } else if (full.endsWith(".ts")) {
          const content = await readFile(full, "utf8");
          if (/\bfetch\s*\(/.test(content) || content.includes("download.geonames") || content.includes("ourairports.com")) {
            violations.push(full);
          }
        }
      }
    }
    for (const dir of dirs) {
      await walk(dir);
    }
    expect(violations).toEqual([]);
  });
});
