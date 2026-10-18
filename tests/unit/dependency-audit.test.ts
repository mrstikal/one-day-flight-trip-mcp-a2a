import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * T-INV-09 smoke (P01 gate): the demo must not depend on any payment or
 * real-travel-provider SDK. This scans declared dependencies of every workspace
 * package for known provider names. It is a guard against accidental
 * integration, not a full transitive license/provenance audit.
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const FORBIDDEN_PROVIDER_TOKENS = [
  "stripe",
  "paypal",
  "braintree",
  "adyen",
  "squareup",
  "checkout.com",
  "amadeus",
  "sabre",
  "travelport",
  "duffel",
  "kiwi",
  "skyscanner",
  "expedia",
  "booking.com",
  "tripadvisor",
  "google-flights",
  "flightapi",
  "google-maps",
  "mapbox",
];

async function workspacePackageJsonPaths(): Promise<string[]> {
  const paths = ["package.json"];
  for (const group of ["apps", "packages"]) {
    const dir = join(repoRoot, group);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        paths.push(join(group, entry.name, "package.json"));
      }
    }
  }
  return paths;
}

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(full)));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(full);
    }
  }
  return files;
}

describe("dependency audit", () => {
  it("declares no payment or real-travel-provider SDK", async () => {
    const violations: string[] = [];
    for (const relativePath of await workspacePackageJsonPaths()) {
      const raw = await readFile(join(repoRoot, relativePath), "utf8");
      const manifest = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      for (const name of names) {
        const lower = name.toLowerCase();
        for (const token of FORBIDDEN_PROVIDER_TOKENS) {
          if (lower.includes(token)) {
            violations.push(`${relativePath}: ${name}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("removes LangGraph from manifests and source imports (Phase 11 cutover)", async () => {
    const manifestViolations: string[] = [];
    for (const relativePath of await workspacePackageJsonPaths()) {
      const raw = await readFile(join(repoRoot, relativePath), "utf8");
      const manifest = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const name of [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ]) {
        if (name.includes("langchain")) {
          manifestViolations.push(`${relativePath}: ${name}`);
        }
      }
    }
    expect(manifestViolations).toEqual([]);

    const sourceViolations: string[] = [];
    for (const group of ["apps", "packages"]) {
      for (const file of await listTypeScriptFiles(join(repoRoot, group))) {
        const source = await readFile(file, "utf8");
        if (/from\s+["']@langchain\/|require\(\s*["']@langchain\//.test(source)) {
          sourceViolations.push(file.slice(repoRoot.length));
        }
      }
    }
    expect(sourceViolations).toEqual([]);
  });
});
