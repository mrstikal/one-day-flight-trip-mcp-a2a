import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/** Insert a fixture anonymous session; returns its id. */
export async function createFixtureSession(client: Pick<PoolClient, "query">): Promise<string> {
  const id = randomUUID();
  const tokenHash = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  await client.query(
    `INSERT INTO odft_app.anonymous_sessions (id, token_hash, csrf_token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [id, tokenHash, "f".repeat(64)],
  );
  return id;
}
