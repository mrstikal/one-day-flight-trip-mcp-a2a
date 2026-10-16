import type { Pool, PoolClient } from "pg";
import type { EffectKey } from "@odft/contracts";
import { lockOperationFence, type OperationFencingContext } from "./operations/fencing.js";

/** Effect ledger (02-architecture.md section 7): replay returns the stored result. */

type Queryable = Pick<PoolClient, "query">;

/** Operation identity a stale worker must not be able to write under. */
export type OperationFence = OperationFencingContext;

/** Verify the caller still owns the operation fence (blocks token rotation). */
export async function assertOperationFence(
  client: Queryable,
  fence: OperationFence,
): Promise<void> {
  await lockOperationFence(client, fence);
}

export async function readEffect(client: Queryable, key: EffectKey): Promise<unknown | undefined> {
  const result = await client.query<{ result: unknown }>(
    `SELECT result FROM odft_app.workflow_effects
      WHERE operation_id = $1 AND node_name = $2 AND effect_scope = $3`,
    [key.operationId, key.nodeName, key.effectScope],
  );
  const row = result.rows[0];
  return row ? row.result : undefined;
}

export async function writeEffect(
  client: Queryable,
  key: EffectKey,
  result: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO odft_app.workflow_effects (operation_id, node_name, effect_scope, result)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (operation_id, node_name, effect_scope) DO NOTHING`,
    [key.operationId, key.nodeName, key.effectScope, JSON.stringify(result)],
  );
}

/**
 * Fenced effect write: a short transaction that verifies the operation fence
 * before storing the result, so a worker that lost its lease cannot win the
 * `ON CONFLICT DO NOTHING` race against the new owner's result.
 */
export async function writeEffectFenced(
  pool: Pool,
  fence: OperationFence,
  key: EffectKey,
  result: unknown,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertOperationFence(client, fence);
    await writeEffect(client, key, result);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original error matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Fenced effect read: a stale worker reads nothing and performs no new call. */
export async function readEffectFenced(
  pool: Pool,
  fence: OperationFence,
  key: EffectKey,
): Promise<unknown | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertOperationFence(client, fence);
    const result = await readEffect(client, key);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original error matters.
    }
    throw error;
  } finally {
    client.release();
  }
}
