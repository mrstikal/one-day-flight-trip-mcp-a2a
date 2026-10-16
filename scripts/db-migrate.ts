import { loadLocalEnv } from "./_load-env.js";
import {
  ConfigError,
  createPool,
  parseServerConfig,
  runMigrations,
  type ServerConfig,
} from "@odft/persistence";

loadLocalEnv();

function loadConfig(): ServerConfig | undefined {
  try {
    return parseServerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return undefined;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    return;
  }

  const pool = createPool(config, { applicationName: "odft-migrate" });
  try {
    const result = await runMigrations(pool);
    process.stdout.write(
      JSON.stringify({ applied: result.applied, skipped: result.skipped }) + "\n",
    );
  } finally {
    await pool.end();
  }
}

await main();
