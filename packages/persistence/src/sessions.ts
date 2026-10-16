import type { PoolClient } from "pg";

export interface SessionRecord {
  readonly id: string;
  readonly csrfTokenHash: string;
  readonly expiresAt: Date;
}

interface SessionRow {
  id: string;
  csrf_token_hash: string;
  expires_at: Date;
}

function toSession(row: SessionRow): SessionRecord {
  return { id: row.id, csrfTokenHash: row.csrf_token_hash, expiresAt: row.expires_at };
}

export async function createSession(
  client: Pick<PoolClient, "query">,
  input: { id: string; tokenHash: string; csrfTokenHash: string; expiresAt: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO odft_app.anonymous_sessions (id, token_hash, csrf_token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       csrf_token_hash = EXCLUDED.csrf_token_hash,
       expires_at = EXCLUDED.expires_at`,
    [input.id, input.tokenHash, input.csrfTokenHash, input.expiresAt],
  );
}

export async function getSession(
  client: Pick<PoolClient, "query">,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<SessionRecord | undefined> {
  const result = await client.query<SessionRow>(
    `SELECT id, csrf_token_hash, expires_at FROM odft_app.anonymous_sessions WHERE id = $1${
      options.forUpdate ? " FOR UPDATE" : ""
    }`,
    [id],
  );
  const row = result.rows[0];
  return row ? toSession(row) : undefined;
}

/**
 * Look up an unexpired session by its stored token hash. The raw cookie token is
 * never persisted, so authorization always resolves through this hash.
 */
export async function getSessionByTokenHash(
  client: Pick<PoolClient, "query">,
  tokenHash: string,
): Promise<SessionRecord | undefined> {
  const result = await client.query<SessionRow>(
    `SELECT id, csrf_token_hash, expires_at
       FROM odft_app.anonymous_sessions
      WHERE token_hash = $1 AND expires_at > now()`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? toSession(row) : undefined;
}

/**
 * Sliding expiry renewal. Preserves the session id, token hash, and CSRF hash so
 * concurrent tabs keep ownership; only the expiry and last-seen time advance.
 */
export async function renewSession(
  client: Pick<PoolClient, "query">,
  id: string,
  expiresAt: Date,
): Promise<SessionRecord | undefined> {
  const result = await client.query<SessionRow>(
    `UPDATE odft_app.anonymous_sessions
        SET expires_at = $2, last_seen_at = now()
      WHERE id = $1
      RETURNING id, csrf_token_hash, expires_at`,
    [id, expiresAt],
  );
  const row = result.rows[0];
  return row ? toSession(row) : undefined;
}
