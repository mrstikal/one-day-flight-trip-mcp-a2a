import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkReadiness,
  createWorkerIdentity,
  runMigrations,
  setupCheckpointer,
  writeWorkerHeartbeat,
} from "@odft/persistence";

/**
 * Foundation integration evidence against a real (disposable) PostgreSQL 17
 * database: real SQL migrations, the official LangGraph PostgreSQL checkpointer
 * schema, worker heartbeat persistence, and readiness behavior.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is required for integration tests. Start PostgreSQL " +
      "(docker compose up -d postgres) and provide TEST_DATABASE_URL.",
  );
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL.");
}
const testDatabaseName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");
if (!testDatabaseName.endsWith("_test")) {
  throw new Error(
    `Refusing to run destructive integration tests against non-test database "${testDatabaseName}".`,
  );
}

const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

beforeAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS odft_app CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS odft_checkpoint CASCADE");
  await runMigrations(pool);
  await setupCheckpointer(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("foundation migrations and checkpointer", () => {
  it("creates the app schemas and the worker heartbeat table", async () => {
    const result = await pool.query<{ present: boolean }>(
      "SELECT to_regclass('odft_app.worker_heartbeat') IS NOT NULL AS present",
    );
    expect(result.rows[0]?.present).toBe(true);
  });

  it("is idempotent: a second migration run applies nothing", async () => {
    const again = await runMigrations(pool);
    expect(again.applied).toEqual([]);
    expect(again.skipped).toContain("0001-foundation");
  });

  it("creates the official checkpointer tables", async () => {
    const result = await pool.query<{ name: string; present: boolean }>(
      `SELECT name, to_regclass('odft_checkpoint.' || name) IS NOT NULL AS present
         FROM unnest($1::text[]) AS name`,
      [["checkpoints", "checkpoint_blobs", "checkpoint_writes", "checkpoint_migrations"]],
    );
    for (const row of result.rows) {
      expect(row.present, `table ${row.name}`).toBe(true);
    }
  });

  it("is safe to run the checkpointer setup again", async () => {
    await expect(setupCheckpointer(pool)).resolves.toBeUndefined();
  });

  it("rejects a changed checksum for an already-applied migration", async () => {
    await pool.query(
      "UPDATE odft_app.schema_migrations SET checksum = 'mutated' WHERE version = '0001-foundation'",
    );
    await expect(runMigrations(pool)).rejects.toThrow(/modified after being applied/);
    await pool.query("DELETE FROM odft_app.schema_migrations WHERE version = '0001-foundation'");
    const restored = await runMigrations(pool);
    expect(restored.applied).toEqual(["0001-foundation"]);
  });

  it("produces a distinct worker identity on every call (restart safety)", () => {
    const first = createWorkerIdentity();
    const second = createWorkerIdentity();
    expect(first.workerId).not.toBe(second.workerId);
  });
});

describe("readiness and worker heartbeat", () => {
  it("is not ready without a recent worker heartbeat", async () => {
    await pool.query("DELETE FROM odft_app.worker_heartbeat");
    const report = await checkReadiness(pool);
    expect(report.ready).toBe(false);
    expect(report.checks.database.ok).toBe(true);
    expect(report.checks.migrations.ok).toBe(true);
    expect(report.checks.checkpointer.ok).toBe(true);
    expect(report.checks.workerHeartbeat.ok).toBe(false);
  });

  it("is ready after a real heartbeat is written", async () => {
    await writeWorkerHeartbeat(pool, createWorkerIdentity());
    const report = await checkReadiness(pool);
    expect(report.ready).toBe(true);
    expect(report.checks.workerHeartbeat.ok).toBe(true);
  });

  it("becomes not ready again when the heartbeat is stale", async () => {
    await pool.query(
      "UPDATE odft_app.worker_heartbeat SET last_heartbeat_at = now() - interval '1 hour'",
    );
    const report = await checkReadiness(pool);
    expect(report.ready).toBe(false);
    expect(report.checks.workerHeartbeat.ok).toBe(false);
  });
});
