import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdmissionManifest, loadCountryPolicy, type CountryRef } from "@odft/data";

/** T-UT-REF-01 (FR-REF-1, FR-REF-4): explicit admission manifest, no continent filtering. */

const manifest = new AdmissionManifest(loadCountryPolicy());

describe("T-UT-REF-01 admission manifest", () => {
  it("admits EU members and the listed non-EU countries", () => {
    const expected = [
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
      "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
      "GB", "CH", "NO", "IS", "LI", "AL", "BA", "ME", "MK", "RS", "MD", "UA", "BY",
      "AD", "MC", "SM", "VA", "XK",
    ];
    for (const key of expected) {
      expect(manifest.isAdmittedCountry(key), key).toBe(true);
    }
  });

  it("excludes GE/AM/AZ/KZ", () => {
    for (const key of ["GE", "AM", "AZ", "KZ"]) {
      expect(manifest.isAdmittedCountry(key), key).toBe(false);
    }
  });

  it("flags XK as a documented application/source extension", () => {
    expect(manifest.isAdmittedCountry("XK")).toBe(true);
    expect(manifest.extensionNote("XK")).toMatch(/extension/i);
  });

  it("admits TR/RU only through reviewed allowlists", () => {
    expect(manifest.isAdmittedCity("TR", "Istanbul")).toBe(true);
    expect(manifest.isAdmittedCity("TR", "Ankara")).toBe(false);
    expect(manifest.isAdmittedAirport("TR", "IST")).toBe(true);
    expect(manifest.isAdmittedAirport("TR", "SAW")).toBe(false);
    expect(manifest.isAdmittedAirport("RU", "SVO")).toBe(true);
    expect(manifest.isAdmittedAirport("RU", "DME")).toBe(true);
    expect(manifest.isAdmittedAirport("RU", "VKO")).toBe(true);
    expect(manifest.isAdmittedAirport("RU", "LED")).toBe(true);
    expect(manifest.isAdmittedAirport("RU", "KGD")).toBe(true);
    expect(manifest.isAdmittedAirport("RU", "VVO")).toBe(false);
  });

  it("documents island exceptions and curated direct pairs", () => {
    const policy = manifest.policy;
    const islands = policy.islandExceptions.map((entry) => entry.name);
    expect(islands).toEqual(expect.arrayContaining(["Azores", "Madeira", "Canary Islands"]));
    expect(policy.curatedDirectPairs).toEqual(
      expect.arrayContaining([
        ["PRG", "FCO"],
        ["PRG", "BCN"],
      ]),
    );
  });

  it("emits only admitted countries, with XK marked as an extension", async () => {
    const path = fileURLToPath(new URL("../../../data/reference/countries.ndjson", import.meta.url));
    const rows = (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CountryRef);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(manifest.isAdmittedCountry(row.countryKey), row.countryKey).toBe(true);
      expect(row.admitted).toBe(true);
    }
    const xk = rows.find((row) => row.countryKey === "XK");
    expect(xk?.extension).toBe(true);
    expect(xk?.policyNote).toMatch(/extension/i);
    expect(rows.some((row) => row.countryKey === "GE")).toBe(false);
  });
});
