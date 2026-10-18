import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

/**
 * Phase 09 shared delegation fixture: inserts a valid `agent_delegations` row
 * through the real `insertAgentDelegation` helper (never raw SQL, so schema
 * NOT NULL columns cannot drift out of sync with the test).
 */
export async function fixtureDelegation(
  pool: Pool,
  input: {
    tripId: string;
    operationId: string;
    taskId?: string;
    status?: "pending" | "dispatched" | "working" | "input_required" | "revoked";
  },
): Promise<string> {
  const { insertAgentDelegation } = await import("@odft/persistence");
  const record = await insertAgentDelegation(pool, {
    tripId: input.tripId,
    originatingOperationId: input.operationId,
    acceptedRevision: 1,
    skillId: "flight.recommend.v1",
    agentIdentity: "flight-agent",
    endpointUrl: "http://127.0.0.1:4101",
    cardVersion: "v1",
    snapshotId: randomUUID(),
    inputFingerprint: "a".repeat(64),
    scope: { domains: ["flights"] },
  });
  if (input.taskId) {
    await pool.query(`UPDATE odft_app.agent_delegations SET task_id = $2 WHERE id = $1`, [
      record.id,
      input.taskId,
    ]);
  }
  if (input.status && input.status !== "pending") {
    await pool.query(`UPDATE odft_app.agent_delegations SET status = $2 WHERE id = $1`, [
      record.id,
      input.status,
    ]);
  }
  return record.id;
}
