import { Pool } from "pg";
import { runMigrations, loadReferenceData } from "@odft/persistence";

/**
 * Shared real-PostgreSQL setup for the Phase 03 protocol integration tests.
 * Drops the protocol schema as well, so the SDK task tables are recreated by
 * the checksummed migration on every run.
 */

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required for integration tests. Start PostgreSQL " +
        "(docker compose up -d postgres) and provide TEST_DATABASE_URL.",
    );
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL.");
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run destructive tests against non-test database "${name}".`);
  }
  return url;
}

export function createTestPool(max = 8): Pool {
  return new Pool({ connectionString: requireTestDatabaseUrl(), max });
}

export async function resetProtocolDatabase(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS odft_app CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS odft_protocol CASCADE");
  await runMigrations(pool);
  await loadReferenceData(pool);
}
