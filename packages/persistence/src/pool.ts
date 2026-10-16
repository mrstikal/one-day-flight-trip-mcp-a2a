import { Pool } from "pg";
import type { ServerConfig } from "./config.js";

export interface CreatePoolOptions {
  /** Maximum number of clients in the pool (bounded). Defaults to 10. */
  readonly max?: number;
  /** Value reported in PostgreSQL `application_name`; never contains secrets. */
  readonly applicationName?: string;
}

/**
 * Create a bounded PostgreSQL connection pool from validated configuration.
 *
 * The database URL is never logged. Idle-client errors are logged as a
 * single-line JSON record with only the error message, never the connection
 * string or credentials.
 */
export function createPool(config: ServerConfig, options: CreatePoolOptions = {}): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? "odft",
  });

  pool.on("error", (error: Error) => {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        component: "pg-pool",
        message: "idle client error",
        error: error.message,
      }) + "\n",
    );
  });

  return pool;
}
