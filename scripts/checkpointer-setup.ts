import { loadLocalEnv } from "./_load-env.js";
import {
  CHECKPOINT_SCHEMA,
  ConfigError,
  createPool,
  parseServerConfig,
  setupCheckpointer,
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

  const pool = createPool(config, { applicationName: "odft-checkpointer-setup" });
  try {
    await setupCheckpointer(pool);
    process.stdout.write(
      `Checkpointer schema "${CHECKPOINT_SCHEMA}" is set up.\n`,
    );
  } finally {
    await pool.end();
  }
}

await main();
