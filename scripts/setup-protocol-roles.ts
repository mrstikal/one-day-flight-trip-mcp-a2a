import { Pool } from "pg";
import { loadLocalEnv } from "./_load-env.js";

/**
 * Phase 03 protocol role setup (plan §3.6, §3.15), extended in Phase 06 with the
 * two research-specialist roles.
 *
 * Idempotently creates the protocol-schema access role, the read-only MCP role
 * and the three least-privilege agent roles, granting only what each surface
 * needs. Passwords come from the environment and are never committed or logged.
 * Runs against the database named by `DATABASE_URL`; refuses non-local hosts
 * unless explicitly allowed.
 */

loadLocalEnv();

const PROTOCOL_ROLE = "odft_protocol_service";
const MCP_READONLY_ROLE = "odft_mcp_readonly";
const AGENT_ROLES = [
  {
    role: "odft_flight_agent",
    passwordEnv: "ODFT_FLIGHT_AGENT_PASSWORD",
    taskTables: ["agent_tasks_flight"],
  },
  {
    role: "odft_accommodation_agent",
    passwordEnv: "ODFT_ACCOMMODATION_AGENT_PASSWORD",
    // The optional Agent B implementation intentionally shares this restricted
    // role, so it needs both accommodation task tables.
    taskTables: ["agent_tasks_accommodation", "agent_tasks_accommodation_alt"],
  },
  {
    role: "odft_city_guide_agent",
    passwordEnv: "ODFT_CITY_GUIDE_AGENT_PASSWORD",
    taskTables: ["agent_tasks_city_guide"],
  },
] as const;

function requirePassword(envName: string): string {
  const value = process.env[envName];
  if (!value || value.length < 16) {
    throw new Error(`${envName} must be set (at least 16 characters) before running this script`);
  }
  return value;
}

/** Least-privilege profile for one specialist agent role. */
async function grantAgentRole(
  pool: Pool,
  role: string,
  taskTables: readonly string[],
): Promise<void> {
  await pool.query(`GRANT USAGE ON SCHEMA odft_protocol TO ${role}`);
  // Remove the legacy broad grant before applying the narrow one. Without this
  // an existing database keeps `ALL TABLES` DML on every specialist's tasks.
  await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA odft_protocol FROM ${role}`);
  // Ownership isolation: an agent role may only touch its OWN task table(s).
  // The SDK's row scoping is not a security boundary by itself, and `ALL
  // TABLES` would let one specialist rewrite another specialist's tasks.
  for (const table of taskTables) {
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON odft_protocol.${table} TO ${role}`);
  }
  await pool.query(`GRANT USAGE ON SCHEMA odft_app TO ${role}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE ON odft_app.protocol_inbound_messages,
            odft_app.protocol_task_control, odft_app.protocol_validated_outputs TO ${role}`,
  );
  // INSERT ... RETURNING reads every returned column; grant SELECT only on the
  // returned columns instead of the whole observation table (cross-trip reads
  // stay restricted).
  await pool.query(`GRANT INSERT ON odft_app.protocol_observations TO ${role}`);
  await pool.query(
    `GRANT SELECT (id, source, kind, trip_id, operation_id, delegation_id, task_id,
                   context_id, trace_id, payload, payload_hash, occurred_at,
                   application_event_id, bridge_skipped_at)
        ON odft_app.protocol_observations TO ${role}`,
  );
  await pool.query(
    `GRANT SELECT ON odft_app.agent_delegations, odft_app.reference_countries,
            odft_app.reference_cities, odft_app.reference_landmarks,
            odft_app.reference_airports, odft_app.reference_city_airports,
            odft_app.reference_manifests, odft_app.reference_route_evidence,
            odft_app.scenario_snapshots, odft_app.route_validations,
            odft_app.schedule_validations, odft_app.trips,
            odft_app.simulation_faults TO ${role}`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION odft_app.claim_delegated_task(text, uuid, text) TO ${role}`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION odft_app.reserve_delegated_call(
        text, uuid, text, text, text, text, text, text, text, text, text,
        integer, numeric, numeric, integer, numeric, integer, numeric) TO ${role}`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION odft_app.settle_delegated_call(
        text, uuid, integer, integer, integer, integer, numeric, text, integer, text, integer, text, text) TO ${role}`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION odft_app.mark_delegated_call_unknown(text, uuid, text, integer) TO ${role}`,
  );
  await pool.query(`GRANT SELECT ON odft_app.llm_calls TO ${role}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const host = new URL(databaseUrl).hostname;
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host) &&
    process.env.ODFT_ALLOW_REMOTE_ROLES !== "1"
  ) {
    throw new Error(`refusing to manage roles on non-local host ${host}`);
  }
  const protocolPassword = requirePassword("ODFT_PROTOCOL_ROLE_PASSWORD");
  const mcpPassword = requirePassword("ODFT_MCP_READONLY_PASSWORD");
  const agentPasswords = AGENT_ROLES.map((entry) => ({
    ...entry,
    password: requirePassword(entry.passwordEnv),
  }));

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
         ${AGENT_ROLES.map(
           (entry) =>
             `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${entry.role}') THEN
                CREATE ROLE ${entry.role} LOGIN;
              END IF;`,
         ).join("\n         ")}
       END $$`,
    );
    await pool.query(
      `ALTER ROLE ${PROTOCOL_ROLE} WITH PASSWORD '${protocolPassword.replace(/'/g, "''")}'`,
    );
    await pool.query(
      `ALTER ROLE ${MCP_READONLY_ROLE} WITH PASSWORD '${mcpPassword.replace(/'/g, "''")}'`,
    );
    for (const entry of agentPasswords) {
      await pool.query(
        `ALTER ROLE ${entry.role} WITH PASSWORD '${entry.password.replace(/'/g, "''")}'`,
      );
    }

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

    // Specialist agents: task storage + admission + counters + delegated ledger
    // functions; NO write privileges on trip/scenario/selection/proposal/
    // decision/reservation tables (proven by the agent write-denial tests).
    for (const entry of AGENT_ROLES) {
      await grantAgentRole(pool, entry.role, entry.taskTables);
    }
    process.stdout.write(
      `protocol roles ready: ${PROTOCOL_ROLE} (protocol schema), ${MCP_READONLY_ROLE} (read-only reference), ` +
        `${AGENT_ROLES.map((entry) => entry.role).join(", ")} (task storage + delegated ledger)\n`,
    );
  } finally {
    await pool.end();
  }
}

await main();
