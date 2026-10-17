import { Pool } from "pg";
import { loadLocalEnv } from "./_load-env.js";

/**
 * Phase 03 protocol role setup (plan §3.6, §3.15).
 *
 * Idempotently creates the protocol-schema access role and the read-only MCP
 * role, granting only what each surface needs. Passwords come from the
 * environment (`ODFT_PROTOCOL_ROLE_PASSWORD`, `ODFT_MCP_READONLY_PASSWORD`) and
 * are never committed or logged. Runs against the database named by
 * `DATABASE_URL`; refuses non-local hosts unless explicitly allowed.
 */

loadLocalEnv();

const PROTOCOL_ROLE = "odft_protocol_service";
const MCP_READONLY_ROLE = "odft_mcp_readonly";
const FLIGHT_AGENT_ROLE = "odft_flight_agent";

function requirePassword(envName: string): string {
  const value = process.env[envName];
  if (!value || value.length < 16) {
    throw new Error(`${envName} must be set (at least 16 characters) before running this script`);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const host = new URL(databaseUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && process.env.ODFT_ALLOW_REMOTE_ROLES !== "1") {
    throw new Error(`refusing to manage roles on non-local host ${host}`);
  }
  const protocolPassword = requirePassword("ODFT_PROTOCOL_ROLE_PASSWORD");
  const mcpPassword = requirePassword("ODFT_MCP_READONLY_PASSWORD");
  const flightAgentPassword = requirePassword("ODFT_FLIGHT_AGENT_PASSWORD");

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROTOCOL_ROLE}') THEN
           CREATE ROLE ${PROTOCOL_ROLE} LOGIN;
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MCP_READONLY_ROLE}') THEN
           CREATE ROLE ${MCP_READONLY_ROLE} LOGIN;
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${FLIGHT_AGENT_ROLE}') THEN
           CREATE ROLE ${FLIGHT_AGENT_ROLE} LOGIN;
         END IF;
       END $$`,
    );
    await pool.query(`ALTER ROLE ${PROTOCOL_ROLE} WITH PASSWORD '${protocolPassword.replace(/'/g, "''")}'`);
    await pool.query(`ALTER ROLE ${MCP_READONLY_ROLE} WITH PASSWORD '${mcpPassword.replace(/'/g, "''")}'`);
    await pool.query(`ALTER ROLE ${FLIGHT_AGENT_ROLE} WITH PASSWORD '${flightAgentPassword.replace(/'/g, "''")}'`);

    // Protocol service: read/write the protocol schema and the protocol tables.
    await pool.query(`GRANT USAGE ON SCHEMA odft_protocol TO ${PROTOCOL_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA odft_protocol TO ${PROTOCOL_ROLE}`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA odft_app TO ${PROTOCOL_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE ON odft_app.protocol_inbound_messages,
              odft_app.protocol_task_control, odft_app.protocol_validated_outputs,
              odft_app.protocol_outbound_messages, odft_app.coordinator_runs,
              odft_app.agent_delegations, odft_app.protocol_observations TO ${PROTOCOL_ROLE}`,
    );

    // Read-only MCP access: reference data, frozen snapshots, the delegated
    // trip row (preferences/route facts only), persisted route approvals and
    // the immutable fault overlay. No write grant of any kind.
    await pool.query(`GRANT USAGE ON SCHEMA odft_app TO ${MCP_READONLY_ROLE}`);
    await pool.query(
      `GRANT SELECT ON odft_app.reference_countries, odft_app.reference_cities,
              odft_app.reference_landmarks, odft_app.reference_airports,
              odft_app.reference_city_airports, odft_app.scenario_snapshots,
              odft_app.reference_manifests, odft_app.reference_route_evidence,
              odft_app.route_validations, odft_app.schedule_validations,
              odft_app.trips, odft_app.simulation_faults TO ${MCP_READONLY_ROLE}`,
    );
    // Phase 05 Flight Agent: task storage + admission + counters + delegated
    // ledger functions; NO write privileges on trip/scenario/selection/proposal/
    // decision/reservation tables (proven by the delegated-governance test).
    await pool.query(`GRANT USAGE ON SCHEMA odft_protocol TO ${FLIGHT_AGENT_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA odft_protocol TO ${FLIGHT_AGENT_ROLE}`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA odft_app TO ${FLIGHT_AGENT_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE ON odft_app.protocol_inbound_messages,
              odft_app.protocol_task_control, odft_app.protocol_validated_outputs TO ${FLIGHT_AGENT_ROLE}`,
    );
    await pool.query(
      `GRANT INSERT ON odft_app.protocol_observations TO ${FLIGHT_AGENT_ROLE}`,
    );
    await pool.query(
      `GRANT SELECT ON odft_app.agent_delegations, odft_app.reference_countries,
              odft_app.reference_cities, odft_app.reference_landmarks,
              odft_app.reference_airports, odft_app.reference_city_airports,
              odft_app.reference_manifests, odft_app.reference_route_evidence,
              odft_app.scenario_snapshots, odft_app.route_validations,
              odft_app.schedule_validations, odft_app.trips,
              odft_app.simulation_faults TO ${FLIGHT_AGENT_ROLE}`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION odft_app.claim_delegated_task(text, uuid, text) TO ${FLIGHT_AGENT_ROLE}`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION odft_app.reserve_delegated_call(
          text, uuid, text, text, text, text, text, text, text, text, text,
          integer, numeric, numeric, integer, numeric, integer, numeric) TO ${FLIGHT_AGENT_ROLE}`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION odft_app.settle_delegated_call(
          text, uuid, integer, integer, integer, integer, numeric, text, integer, text, integer, text, text) TO ${FLIGHT_AGENT_ROLE}`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION odft_app.mark_delegated_call_unknown(text, uuid, text, integer) TO ${FLIGHT_AGENT_ROLE}`,
    );
    await pool.query(
      `GRANT SELECT ON odft_app.llm_calls TO ${FLIGHT_AGENT_ROLE}`,
    );
    process.stdout.write(
      `protocol roles ready: ${PROTOCOL_ROLE} (protocol schema), ${MCP_READONLY_ROLE} (read-only reference), ` +
        `${FLIGHT_AGENT_ROLE} (task storage + delegated ledger)\n`,
    );
  } finally {
    await pool.end();
  }
}

await main();
