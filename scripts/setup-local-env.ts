import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Create a development-only `.env` from `.env.example` with a random
 * SESSION_HMAC_KEY. Never overwrites an existing `.env` and never prints the
 * generated secret.
 */

const ENV_PATH = ".env";
const EXAMPLE_PATH = ".env.example";
const PLACEHOLDER = "replace-me";

function main(): void {
  if (existsSync(ENV_PATH)) {
    process.stdout.write(
      `${ENV_PATH} already exists; leaving it unchanged. Delete it manually to regenerate.\n`,
    );
    return;
  }
  if (!existsSync(EXAMPLE_PATH)) {
    process.stderr.write(`${EXAMPLE_PATH} not found; cannot generate ${ENV_PATH}.\n`);
    process.exitCode = 1;
    return;
  }

  const secret = randomBytes(48).toString("hex");
  const contents = readFileSync(EXAMPLE_PATH, "utf8").replaceAll(PLACEHOLDER, secret);
  writeFileSync(ENV_PATH, contents, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
  process.stdout.write(
    `Wrote ${ENV_PATH} with a generated SESSION_HMAC_KEY.\n` +
      `It is git-ignored; do not commit it. Values are development placeholders only.\n`,
  );
}

main();
