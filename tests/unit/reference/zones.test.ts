import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPlaceholderZone, resolveZone, type AirportRef } from "@odft/data";

/** T-UT-REF-06 (FR-REF-6): zone evidence rules and eligibility gating. */

describe("T-UT-REF-06 zone resolution", () => {
  it("accepts a single operational geo-tz candidate", () => {
    const zone = resolveZone(["Europe/Prague"], 50.1, 14.26, "Europe/Prague");
    expect(zone.zone).toBe("Europe/Prague");
    expect(zone.eligibleOrigin).toBe(true);
    expect(zone.zoneEvidence.length).toBeGreaterThan(0);
    expect(zone.ambiguous).toBe(false);
    expect(zone.ocean).toBe(false);
  });

  it("blocks ocean / Etc placeholder zones", () => {
    const zone = resolveZone(["Etc/GMT+3"], 0, -40, undefined);
    expect(zone.eligibleOrigin).toBe(false);
    expect(zone.ocean).toBe(true);
    expect(isPlaceholderZone(zone.zone)).toBe(true);
  });

  it("disambiguates multiple candidates using the reference city zone", () => {
    const zone = resolveZone(["Europe/Rome", "Europe/Vatican"], 41.9, 12.45, "Europe/Rome");
    expect(zone.zone).toBe("Europe/Rome");
    expect(zone.ambiguous).toBe(false);
    expect(zone.eligibleOrigin).toBe(true);
  });

  it("blocks ambiguous zones that the city zone cannot disambiguate", () => {
    const zone = resolveZone(["Europe/Rome", "Europe/Vatican"], 41.9, 12.45, undefined);
    expect(zone.ambiguous).toBe(true);
    expect(zone.eligibleOrigin).toBe(false);
  });

  it("lets a reviewed override win with a recorded reason", () => {
    const zone = resolveZone(["Etc/GMT+2"], 1, 1, undefined, { zone: "Europe/Lisbon", reason: "reviewed regional override" });
    expect(zone.zoneSource).toBe("override");
    expect(zone.zoneOverrideReason).toBe("reviewed regional override");
    expect(zone.eligibleOrigin).toBe(true);
  });

  it("persists non-empty evidence and blocks Etc zones from origin eligibility", async () => {
    const path = fileURLToPath(new URL("../../../data/reference/airports.ndjson", import.meta.url));
    const rows = (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AirportRef);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.zoneEvidence.length, row.iata).toBeGreaterThan(0);
      if (row.zone.startsWith("Etc/")) {
        expect(row.eligibleOrigin, row.iata).toBe(false);
      }
      if (row.eligibleOrigin) {
        expect(row.zone.startsWith("Etc/"), row.iata).toBe(false);
      }
    }
    const prg = rows.find((row) => row.iata === "PRG");
    expect(prg?.eligibleOrigin).toBe(true);
    expect(prg?.zone).toBe("Europe/Prague");
  });
});
