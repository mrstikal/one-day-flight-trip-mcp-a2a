import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T-UT-OPS-01 guard: the graph wiring must use the official PostgreSQL
 * checkpointer, never an in-memory saver masquerading as durable state. This
 * scans authored source (dist/node_modules excluded) for forbidden symbols.
 */

const ROOTS = ["packages", "apps", "scripts"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const FORBIDDEN_SYMBOLS = ["MemorySaver", "InMemorySaver"];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => full.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

describe("durable checkpointer guard", () => {
  it("does not reference an in-memory checkpointer", async () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of await collectSourceFiles(root)) {
        const content = await readFile(file, "utf8");
        for (const symbol of FORBIDDEN_SYMBOLS) {
          if (content.includes(symbol)) {
            offenders.push(`${file}: ${symbol}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
