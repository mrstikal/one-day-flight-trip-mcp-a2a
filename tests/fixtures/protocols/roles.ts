import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Shared protocol-role fixture for integration tests.
 *
 * `scripts/setup-protocol-roles.ts` creates ALL protocol roles
 * (odft_protocol_service, odft_mcp_readonly, odft_flight_agent) and requires
 * every role password. Keeping the passwords and the single runner here means a
 * new role can never be missed by one suite's setup (the Phase 05 flight-agent
 * password regression).
 */

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

export const PROTOCOL_PASSWORD = "test-protocol-password-0123456789";
export const READONLY_PASSWORD = "test-readonly-password-0123456789";
export const FLIGHT_AGENT_PASSWORD = "test-flight-agent-password-0123456789";

/** Run the documented role setup for every protocol role against one test database. */
export function runProtocolRoleSetup(databaseUrl: string): void {
  execFileSync(TSX, ["scripts/setup-protocol-roles.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ODFT_PROTOCOL_ROLE_PASSWORD: PROTOCOL_PASSWORD,
      ODFT_MCP_READONLY_PASSWORD: READONLY_PASSWORD,
      ODFT_FLIGHT_AGENT_PASSWORD: FLIGHT_AGENT_PASSWORD,
    },
    stdio: "pipe",
  });
}
