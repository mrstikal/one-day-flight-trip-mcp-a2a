import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as services from "@odft/services";
import { evaluateItineraryReview as reviewFromServices } from "@odft/services";
import { evaluateItineraryReview as reviewFromWorker } from "../../../apps/worker/src/travel/itinerary-review.js";
import { ensureCityLandmarks as landmarksFromWorker } from "../../../apps/worker/src/travel/landmark-discovery.js";
import { createAiService as aiFromWorker } from "../../../apps/worker/src/ai/service.js";

/**
 * Phase 02 boundary and compatibility assertions.
 *
 * These check the extraction contract that matters beyond types: the services
 * package must stay free of graph/SDK dependencies, and the worker compatibility
 * paths must still resolve to the extracted implementations.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVICES_SRC = join(REPO_ROOT, "packages/services/src");

function listTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(full);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

const FORBIDDEN_IMPORT_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["@odft/workflow", /^@odft\/workflow$/],
  ["langgraph", /^@langchain\//],
  ["MCP SDK", /^@modelcontextprotocol\//],
  ["A2A SDK", /^@a2a-js\/|^a2a-|^@a2a\//],
];

/** Every module specifier of static, dynamic and require() imports in a file. */
function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [
    /from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        specifiers.push(match[1]);
      }
    }
  }
  return specifiers;
}

describe("services boundary", () => {
  it("never imports the graph package, LangGraph, MCP or A2A SDKs", () => {
    const violations: string[] = [];
    for (const file of listTypeScriptFiles(SERVICES_SRC)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of moduleSpecifiers(source)) {
        for (const [name, pattern] of FORBIDDEN_IMPORT_PATTERNS) {
          if (pattern.test(specifier)) {
            violations.push(`${file}: imports ${name} (${specifier})`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not declare graph or SDK dependencies in its manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/services/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const dependencies = Object.keys(manifest.dependencies ?? {});
    expect(dependencies).not.toContain("@odft/workflow");
    expect(dependencies.filter((name) => name.startsWith("@langchain/"))).toEqual([]);
    expect(dependencies.filter((name) => name.startsWith("@modelcontextprotocol/"))).toEqual([]);
    expect(dependencies.filter((name) => /^@a2a-js\/|^a2a-|^@a2a\//.test(name))).toEqual([]);
  });

  it("exposes the package identity and the extracted entry points", () => {
    expect(services.PACKAGE_ID).toBe("@odft/services");
    for (const name of [
      "createAiService",
      "createTravelContextService",
      "createTravelScenarioService",
      "createTravelResearchService",
      "createTravelBookingService",
      "createTravelItineraryService",
      "ensureCityLandmarks",
      "evaluateItineraryReview",
      "operationAuthority",
      "fencingContext",
      "fencingContextFor",
    ]) {
      expect(name in services, `missing export ${name}`).toBe(true);
    }
  });
});

describe("worker compatibility shims", () => {
  it("re-export the exact extracted implementations", () => {
    expect(reviewFromWorker).toBe(reviewFromServices);
    expect(landmarksFromWorker).toBe(services.ensureCityLandmarks);
    expect(aiFromWorker).toBe(services.createAiService);
  });
});

describe("explicit-snapshot research queries", () => {
  it("are exported from persistence as a read-only path", async () => {
    const persistence = await import("@odft/persistence");
    expect(typeof persistence.loadSnapshotResearchInputs).toBe("function");
    expect(typeof persistence.queryDomainCandidates).toBe("function");
  });
});
