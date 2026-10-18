import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildObservation } from "@odft/protocols";
import { insertProtocolObservation, loadPublicInspector } from "@odft/persistence";
import {
  createTestPool,
  createFixtureTrip,
  createWorkerPools,
  endWorkerPools,
  resetDatabase,
  type WorkerPools,
} from "../_setup.js";
import { fixtureDelegation } from "./_delegation-fixture.js";

/**
 * Phase 09 plan-named inspector coverage (ODTF_PLAN.md Phase 09 tests):
 * the communication map, MCP section, and application timeline render ONLY
 * persisted rows with distinct A2A/MCP/Application edges — and unsafe rows
 * (unknown payloads, overlong strings) never reach the DTOs.
 */

describe("phase 09 inspector communication sections", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createTestPool();
    pools = createWorkerPools();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  it("renders distinct a2a/mcp/application edges from persisted rows", async () => {
    const { tripId } = await createFixtureTrip(pool);
    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const operationId = (created.rows[0] as { id: string }).id;
    await fixtureDelegation(pool, {
      tripId,
      operationId,
      taskId: "task-comm-1",
      status: "working",
    });
    await insertProtocolObservation(
      pool,
      buildObservation({
        source: "mcp-travel-data",
        kind: "mcp_tool_call",
        correlation: { tripId, operationId: null },
        payload: { detail: "search_airports", status: "ok", counters: {} },
      }),
    );
    await insertProtocolObservation(
      pool,
      buildObservation({
        source: "flight-agent",
        kind: "task_completed",
        correlation: { tripId, operationId: null },
        payload: { detail: "recommendations ready", status: "ok", counters: {} },
      }),
    );
    await insertProtocolObservation(
      pool,
      buildObservation({
        source: "coordinator",
        kind: "artifact_received",
        correlation: { tripId, operationId: null },
        payload: { detail: "artifact accepted", status: "ok", counters: {} },
      }),
    );

    const inspector = await loadPublicInspector(pool, tripId);
    expect(inspector.communications.some((row) => row.agentIdentity === "flight-agent")).toBe(true);
    expect(inspector.mcpCalls.some((row) => row.edge === "mcp")).toBe(true);
    const edges = new Set(inspector.timeline.map((row) => row.edge));
    expect(edges.has("a2a")).toBe(true);
    expect(edges.has("mcp")).toBe(true);
    expect(edges.has("application")).toBe(true);
  });

  it("labels card discovery as an A2A edge, never an MCP call", async () => {
    const { tripId } = await createFixtureTrip(pool);
    await insertProtocolObservation(
      pool,
      buildObservation({
        source: "coordinator",
        kind: "card_discovery",
        correlation: { tripId, operationId: null },
        payload: { detail: "flight-agent", status: "ok", counters: {} },
      }),
    );
    const inspector = await loadPublicInspector(pool, tripId);
    expect(inspector.mcpCalls.length).toBe(0);
    expect(inspector.timeline.some((row) => row.kind === "card_discovery")).toBe(true);
  });

  it("keeps durations null (never fabricated zero) and shows attempts", async () => {
    const { tripId } = await createFixtureTrip(pool);
    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const delegationId = await fixtureDelegation(pool, {
      tripId,
      operationId: (created.rows[0] as { id: string }).id,
    });
    await pool.query(`UPDATE odft_app.agent_delegations SET attempt = 3 WHERE id = $1`, [
      delegationId,
    ]);
    const inspector = await loadPublicInspector(pool, tripId);
    const row = inspector.communications.find((entry) => entry.delegationId === delegationId);
    expect(row?.durationMs).toBeNull();
    expect(row?.attempt).toBe(3);
  });
});
