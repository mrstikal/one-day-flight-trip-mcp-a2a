import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Pool } from "pg";

/** Dedicated schema for the official LangGraph PostgreSQL checkpointer tables. */
export const CHECKPOINT_SCHEMA = "odft_checkpoint";

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

/** Tables the official `PostgresSaver.setup()` must have created. */
export const CHECKPOINT_TABLES = [
  "checkpoints",
  "checkpoint_blobs",
  "checkpoint_writes",
  "checkpoint_migrations",
] as const;

/**
 * One-shot deployment command: ensure the checkpoint schema exists and let the
 * official LangGraph `PostgresSaver` create/upgrade its tables (`setup()`).
 *
 * After `setup()`, the official tables are verified so a partially initialized
 * schema is reported instead of silently accepted.
 *
 * This is intentionally explicit rather than running DDL on every web/worker
 * start, which would race across processes. The caller owns the pool and is
 * responsible for closing it.
 */
export async function setupCheckpointer(
  pool: Pool,
  schema: string = CHECKPOINT_SCHEMA,
): Promise<void> {
  if (!IDENTIFIER_PATTERN.test(schema)) {
    throw new Error(`Invalid checkpointer schema identifier: "${schema}"`);
  }

  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    client.release();
  }

  const saver = new PostgresSaver(pool, undefined, { schema });
  await saver.setup();
  await verifyCheckpointerSetup(pool, schema);
}

/** Throw when any official checkpointer table is missing. */
export async function verifyCheckpointerSetup(
  pool: Pool,
  schema: string = CHECKPOINT_SCHEMA,
): Promise<void> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT bool_and(to_regclass($1 || '.' || name) IS NOT NULL) AS present
       FROM unnest($2::text[]) AS name`,
    [schema, CHECKPOINT_TABLES],
  );
  if (result.rows[0]?.present !== true) {
    throw new Error(
      `Checkpointer schema "${schema}" is not fully initialized; run \`npm run checkpointer:setup\`.`,
    );
  }
}
