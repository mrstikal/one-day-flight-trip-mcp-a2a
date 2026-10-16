import { loadLocalEnv } from "./_load-env.js";
import {
  ConfigError,
  createPool,
  loadReferenceData,
  parseServerConfig,
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

  const pool = createPool(config, { applicationName: "odft-reference-load" });
  try {
    const result = await loadReferenceData(pool);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

await main();
