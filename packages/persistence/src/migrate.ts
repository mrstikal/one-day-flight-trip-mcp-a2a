import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

/**
 * Ordered, versioned SQL migration runner.
 *
 * Migration files live at `packages/persistence/migrations/*.sql` next to the
 * package root, so the same relative path resolves from both `src/` (tsx) and
 * `dist/` (production). Each file is applied once, inside its own transaction,
 * and recorded in `odft_app.schema_migrations` with a content checksum.
 *
 * A session-level PostgreSQL advisory lock serializes concurrent migrators.
 * Repeat execution is safe: already-applied versions are skipped, but a changed
 * checksum for an applied version is rejected instead of silently diverging.
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(MODULE_DIR, "..", "migrations");
const MIGRATION_LOCK_KEY = 763_100_001;

/**
 * Canonical list of required migration versions.
 *
 * Kept as a constant (rather than read from disk) so readiness works inside the
 * bundled Next.js server runtime. A unit test asserts this list matches the
 * committed migration files, so it cannot silently drift.
 */
export const MIGRATION_VERSIONS: readonly string[] = [
  "0001-foundation",
  "0002-reference",
  "0003-domain",
  "0004-graph-lease",
  "0008-ai",
  "0009-research",
  "0010-itinerary",
  "0011-self-arranged",
  "0012-voice",
];

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

interface MigrationFile {
  readonly version: string;
  readonly path: string;
}

async function listMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      version: name.replace(/\.sql$/, ""),
      path: join(MIGRATIONS_DIR, name),
    }));
}

/** Versions derived from the committed migration files on disk. */
export async function listMigrationVersions(): Promise<string[]> {
  return (await listMigrationFiles()).map((file) => file.version);
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Apply all pending migrations. Requires a pool whose role may create schemas.
 *
 * @throws {Error} when an applied migration's checksum has changed.
 */
export async function runMigrations(pool: Pool): Promise<MigrationResult> {
  const files = await listMigrationFiles();
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  let lockAcquired = false;

  try {
    // Acquire the serialization lock before any DDL so concurrent first-run
    // migrators cannot race on schema/ledger creation.
    await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
    lockAcquired = true;

    await client.query(`CREATE SCHEMA IF NOT EXISTS odft_app`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS odft_app.schema_migrations (
         version    text PRIMARY KEY,
         checksum   text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const existingResult = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM odft_app.schema_migrations`,
    );
    const existing = new Map(existingResult.rows.map((row) => [row.version, row.checksum]));

    for (const file of files) {
      const sql = await readFile(file.path, "utf8");
      const digest = checksum(sql);
      const previous = existing.get(file.version);

      if (previous !== undefined) {
        if (previous !== digest) {
          throw new Error(
            `Migration ${file.version} was modified after being applied ` +
              `(expected checksum ${previous}, found ${digest}).`,
          );
        }
        skipped.push(file.version);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO odft_app.schema_migrations (version, checksum) VALUES ($1, $2)`,
          [file.version, digest],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(file.version);
    }
  } finally {
    let destroy = false;
    if (lockAcquired) {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]);
      } catch {
        // A connection that cannot release the session lock must not return to
        // the pool still holding it; destroy it to end the session.
        destroy = true;
      }
    }
    client.release(destroy);
  }

  return { applied, skipped };
}
