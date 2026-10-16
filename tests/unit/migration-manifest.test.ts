import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATION_VERSIONS, listMigrationVersions } from "@odft/persistence";

/**
 * Guards against drift between the canonical migration-version constant used by
 * readiness and the committed SQL files on disk.
 */

const migrationsDir = fileURLToPath(
  new URL("../../packages/persistence/migrations/", import.meta.url),
);

describe("migration version manifest", () => {
  it("matches the committed migration files", async () => {
    const files = (await readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();
    expect(files).toEqual([...MIGRATION_VERSIONS]);
    expect(await listMigrationVersions()).toEqual(files);
  });
});
