import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { AdapterError, type LLMAdapter, type StructuredRequest } from "@odft/ai";
import type { RoleProfile } from "@odft/contracts";
import { createTrip, upsertTaskControl, type ServerConfig } from "@odft/persistence";
import {
  createDelegatedFlightRanker,
  rankDelegatedOffers,
  type DelegatedFlightRankingResult,
} from "@odft/services";
import { A2AClient } from "@odft/protocols";
import { createFixtureSession } from "../../fixtures/session.js";
import { fixtureCreationInput } from "../../fixtures/trip.js";
import { claimNextOrFail, testServerConfig } from "../_setup.js";
import { coordinatorDriver } from "../coordinator/_setup.js";
import {
  createFlightDelegation,
  createFlightDelegationFor,
  createMcpTestPool,
  createMcpTestWorkerPools,
  endWorkerPools,
  flightAgentClientConfig,
  flightAgentDatabaseUrl,
  flightDataMessage,
  flightTaskRequestData,
  resetMcpDatabase,
  seedFlightDelegation,
  setupProtocolRoles,
  startFlightAgent,
  startMcpHost,
  stopFlightAgent,
  stopMcpHost,
  waitForFlightAgent,
  waitForHostReady,
  type SeededSnapshot,
  type WorkerPools,
} from "./_setup.js";

/**
 * Phase 05 delegated governance: authority denials (revoked/superseded/wrong
 * snapshot), an infeasible route cannot become a success, the agent role cannot
 * mutate trip state, and the shared trip caps plus the paid reservation path
 * are enforced against real PostgreSQL.
 */

let pool: Pool;
let pools: WorkerPools;
let mcpHost: ChildProcess;
let agent: ChildProcess;
let seeded: SeededSnapshot & { delegationId: string };

async function send(message: ReturnType<typeof flightDataMessage>): Promise<Task> {
  const client = new A2AClient({ config: flightAgentClientConfig() });
  const result = await client.sendMessage("flight-agent", {
    message,
    tenant: "",
    configuration: undefined,
    metadata: undefined,
  });
  if (!("status" in result)) {
    throw new Error("expected a task result");
  }
  return result as Task;
}

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  seeded = await seedFlightDelegation(pool, pools);
  mcpHost = startMcpHost();
  await waitForHostReady(mcpHost);
  agent = startFlightAgent();
  await waitForFlightAgent(agent);
}, 120_000);

afterAll(async () => {
  await stopFlightAgent(agent);
  await stopMcpHost(mcpHost);
  await endWorkerPools(pools);
  await pool.end();
});

describe("delegated governance", () => {
  it("refuses a revoked delegation", async () => {
    const delegationId = await createFlightDelegation(pool, seeded);
    await pool.query(
      `UPDATE odft_app.agent_delegations SET status = 'revoked', revoked_at = now(), revoke_reason = 'test' WHERE id = $1`,
      [delegationId],
    );
    const task = await send(
      flightDataMessage(
        flightTaskRequestData({
          tripId: seeded.tripId,
          operationId: seeded.operationId,
          delegationId,
          snapshotId: seeded.snapshotId,
          scenarioKey: "seeded",
        }),
      ),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(
      task.status?.message?.parts?.[0]?.content?.$case === "text"
        ? task.status.message.parts[0].content.value
        : "",
    ).toMatch(/revoked/);
  }, 60_000);

  it("refuses a request that names a different snapshot than the delegation", async () => {
    const delegationId = await createFlightDelegation(pool, seeded);
    const task = await send(
      flightDataMessage(
        flightTaskRequestData({
          tripId: seeded.tripId,
          operationId: seeded.operationId,
          delegationId,
          snapshotId: "33333333-3333-4333-8333-333333333333",
          scenarioKey: "seeded",
        }),
      ),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(
      task.status?.message?.parts?.[0]?.content?.$case === "text"
        ? task.status.message.parts[0].content.value
        : "",
    ).toMatch(/snapshot/);
  }, 60_000);

  it("never turns an infeasible route into a recommendation success", async () => {
    // PRG -> Ceske Budejovice is rejected at Stage A: the coordinator creates
    // no snapshot and delegates no flight work. Even the strongest forged
    // request — a delegation for that trip pointing at another trip's
    // materialized snapshot — cannot produce a recommendation, because the
    // MCP flight query refuses a trip without a FEASIBLE route approval.
    const sessionClient = await pool.connect();
    let sessionId: string;
    try {
      sessionId = await createFixtureSession(sessionClient);
    } finally {
      sessionClient.release();
    }
    const created = await createTrip(pool, {
      sessionId,
      input: fixtureCreationInput({
        destinationCityId: "geonames:3077916",
        destinationCountryKey: "CZ",
      }),
    });
    if (!("tripId" in created)) {
      throw new Error("fixture createTrip failed");
    }
    await coordinatorDriver(pools).runOperation(await claimNextOrFail(pools));
    const snapshots = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.scenario_snapshots WHERE trip_id = $1`,
      [created.tripId],
    );
    expect(snapshots.rows[0]?.count).toBe("0");
    const delegations = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.agent_delegations WHERE trip_id = $1`,
      [created.tripId],
    );
    expect(delegations.rows[0]?.count).toBe("0");

    const forgedDelegation = await createFlightDelegationFor(pool, {
      tripId: created.tripId,
      operationId: created.operationId,
      snapshotId: seeded.snapshotId,
      inputFingerprint: "f".repeat(64),
    });
    const task = await send(
      flightDataMessage(
        flightTaskRequestData({
          tripId: created.tripId,
          operationId: created.operationId,
          delegationId: forgedDelegation,
          snapshotId: seeded.snapshotId,
          scenarioKey: "forged",
        }),
      ),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(task.artifacts).toHaveLength(0);
    // The failure names the Stage-A gate: the trip has no FEASIBLE approval.
    const message =
      task.status?.message?.parts?.[0]?.content?.$case === "text"
        ? task.status.message.parts[0].content.value
        : "";
    expect(message).toMatch(/FEASIBLE/);
  }, 90_000);

  it("enforces the shared per-trip AI call budget", async () => {
    // Exhaust the SHARED trip ledger (the coordinator's own rows count), then a
    // delegated reservation under the same trip cap must be refused.
    const delegationId = await createFlightDelegation(pool, seeded);
    const taskId = `cap-task-${randomUUID().slice(0, 8)}`;
    const budgetCall = async (maxCallsPerTrip: number) =>
      pool.query<{ outcome: { ok: boolean; code?: string } }>(
        `SELECT odft_app.reserve_delegated_call(
            'flight-agent', $1::uuid, $2, 'trace-cap', 'recommendation:1',
            'recommendation', 'scripted/model', 'test', 'recommendation-v2', 'openrouter', 'test-pricing-v1',
            1000, 0.01, 0.05, $3, 10, 2, 0.1) AS outcome`,
        [delegationId, taskId, maxCallsPerTrip],
      );

    // Without a durable task-control row the reservation is refused safely.
    const orphan = await budgetCall(10);
    expect(orphan.rows[0]?.outcome.ok).toBe(false);
    expect(orphan.rows[0]?.outcome.code).toBe("STALE_AGENT_RESULT");

    const claimed = await pool.query<{ claimed: boolean }>(
      `SELECT odft_app.claim_delegated_task('flight-agent', $1::uuid, $2) AS claimed`,
      [delegationId, taskId],
    );
    expect(claimed.rows[0]?.claimed).toBe(true);
    await upsertTaskControl(pool, {
      agentIdentity: "flight-agent",
      taskId,
      contextId: `ctx-${taskId}`,
      delegationId,
    });
    await pool.query(
      `INSERT INTO odft_app.llm_calls
         (id, trip_id, operation_id, role, model, provider, prompt_version, mode, effect_scope, pricing_version,
          reserved_tokens, reserved_cost_usd, attempts, status, validation_status, actual_cost_usd, cost_status)
       VALUES (gen_random_uuid(), $1, $2, 'recommendation', 'scripted/model', 'test', 'recommendation-v2', 'openrouter',
               'coordinator-seed', 'test-pricing-v1', 1000, 0.01, 1, 'succeeded', 'valid', 0.01, 'actual')`,
      [seeded.tripId, seeded.operationId],
    );
    const exhausted = await budgetCall(1);
    expect(exhausted.rows[0]?.outcome.ok).toBe(false);
    expect(exhausted.rows[0]?.outcome.code).toBe("AI_BUDGET_EXCEEDED");
    // The row above is the only counted call; the refused reservation wrote nothing.
    const counted = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.llm_calls
        WHERE trip_id = $1 AND effect_scope = 'recommendation:1'`,
      [seeded.tripId],
    );
    expect(counted.rows[0]?.count).toBe("0");
  }, 60_000);

  it("proves the agent role cannot mutate trip state or book", async () => {
    const agentPool = new Pool({ connectionString: flightAgentDatabaseUrl(), max: 1 });
    try {
      await expect(
        agentPool.query(`UPDATE odft_app.trips SET revision = revision + 1 WHERE id = $1`, [
          seeded.tripId,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        agentPool.query(
          `INSERT INTO odft_app.reservations (id, trip_id, service_key, offer_id, status)
           VALUES (gen_random_uuid(), $1, 'hotel', 'x', 'confirmed')`,
          [seeded.tripId],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        agentPool.query(`UPDATE odft_app.agent_delegations SET status = 'revoked' WHERE id = $1`, [
          seeded.delegationId,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        agentPool.query(
          `INSERT INTO odft_app.trip_selections (trip_id, service_key, offer_id) VALUES ($1, 'hotel', 'x')`,
          [seeded.tripId],
        ),
      ).rejects.toThrow(/permission denied/);
      // Its own task storage and delegated ledger stay usable.
      const claimed = await agentPool.query<{ claimed: boolean }>(
        `SELECT odft_app.claim_delegated_task('flight-agent', $1::uuid, 'role-check-task') AS claimed`,
        [seeded.delegationId],
      );
      expect(typeof claimed.rows[0]?.claimed).toBe("boolean");
    } finally {
      await agentPool.end();
    }
  }, 30_000);
});

describe("delegated paid path (scripted adapter)", () => {
  const profile: RoleProfile = {
    provider: "openrouter",
    model: "scripted/flight-model",
    timeoutMs: 5_000,
    maxInputTokens: 2_000,
    maxOutputTokens: 200,
    maxAttempts: 2,
    maxCallCostUsd: "0.05",
    inputPriceUsdPerMillion: "1",
    outputPriceUsdPerMillion: "1",
    requestPriceUsd: "0",
    pricingVersion: "scripted-pricing-v1",
    allowedEndpointProviderIds: ["scripted"],
  };
  const limits = {
    maxCallCostUsd: "0.05",
    maxCallsPerTrip: 40,
    maxCostUsdPerTrip: "5",
    maxAttemptsPerScope: 2,
    taskMaxCostUsd: "0.1",
  };
  const candidates = [
    {
      id: "combo-a",
      partyTotalMinor: 30_000,
      perAdultMinor: 15_000,
      totalDurationMinutes: 300,
      stops: 0,
      outboundDeparture: "2026-12-01T06:00:00Z",
      outboundArrival: "2026-12-01T08:00:00Z",
      inboundDeparture: "2026-12-03T18:00:00Z",
      inboundArrival: "2026-12-03T20:00:00Z",
      supportedVariants: ["two_nights" as const],
    },
    {
      id: "combo-b",
      partyTotalMinor: 28_000,
      perAdultMinor: 14_000,
      totalDurationMinutes: 320,
      stops: 1,
      outboundDeparture: "2026-12-01T05:00:00Z",
      outboundArrival: "2026-12-01T07:20:00Z",
      inboundDeparture: "2026-12-03T17:00:00Z",
      inboundArrival: "2026-12-03T19:20:00Z",
      supportedVariants: ["two_nights" as const],
    },
  ];

  function scriptedAdapter(value: unknown, options: { fail?: Error } = {}): LLMAdapter {
    return {
      async generateObject<T>(_request: StructuredRequest<T>) {
        if (options.fail) {
          throw options.fail;
        }
        return {
          value: value as T,
          callId: "scripted-call",
          model: profile.model,
          inputTokens: 100,
          outputTokens: 20,
          costUsd: "0.00012",
          latencyMs: 5,
          attempts: 1,
          mode: "openrouter",
        };
      },
    };
  }

  async function seedPaidTask(): Promise<{ delegationId: string; taskId: string }> {
    const delegationId = await createFlightDelegation(pool, seeded);
    const taskId = `paid-task-${randomUUID().slice(0, 8)}`;
    const claimed = await pool.query<{ claimed: boolean }>(
      `SELECT odft_app.claim_delegated_task('flight-agent', $1::uuid, $2) AS claimed`,
      [delegationId, taskId],
    );
    if (claimed.rows[0]?.claimed !== true) {
      throw new Error("delegated task claim failed");
    }
    await upsertTaskControl(pool, {
      agentIdentity: "flight-agent",
      taskId,
      contextId: `ctx-${taskId}`,
      delegationId,
    });
    return { delegationId, taskId };
  }

  function ranker(adapter: LLMAdapter, serverConfig: ServerConfig = testServerConfig()) {
    return createDelegatedFlightRanker(pool, serverConfig, {
      paidAdapter: adapter,
      paidProfile: profile,
    });
  }

  function rankingInput(
    ids: { delegationId: string; taskId: string },
    overrides: Partial<{ effectScope: string; limits: typeof limits }> = {},
  ) {
    return {
      authority: {
        kind: "delegation" as const,
        delegationId: ids.delegationId,
        agentIdentity: "flight-agent",
        skillId: "flight.recommend.v1",
        taskId: ids.taskId,
        traceId: `trace-${ids.taskId}`,
      },
      effectScope: overrides.effectScope ?? "recommendation:1",
      tradeoff: "cheapest party total against total travel time",
      baselineOfferId: null,
      candidates,
      limits: overrides.limits ?? limits,
    };
  }

  it("reserves, validates and settles a paid reorder", async () => {
    const ids = await seedPaidTask();
    const result = await ranker(
      scriptedAdapter({
        rankedOfferIds: ["combo-b", "combo-a"],
        reasons: [{ offerId: "combo-b", explanation: "combo-b is cheaper with one stop" }],
        tradeoffs: [],
      }),
    ).rank(rankingInput(ids));
    expect(result.mode).toBe("openrouter");
    expect(result.fallbackUsed).toBe(false);
    expect(result.rankedOfferIds).toEqual(["combo-b", "combo-a"]);

    const call = await pool.query<{
      status: string;
      validation_status: string;
      cost_status: string;
      actual_cost_usd: string;
      agent_identity: string;
      delegation_id: string;
      task_id: string;
      trace_id: string;
    }>(
      `SELECT status, validation_status, cost_status, actual_cost_usd, agent_identity, delegation_id, task_id, trace_id
         FROM odft_app.llm_calls WHERE delegation_id = $1`,
      [ids.delegationId],
    );
    expect(call.rows[0]?.status).toBe("succeeded");
    expect(call.rows[0]?.validation_status).toBe("valid");
    expect(Number(call.rows[0]?.actual_cost_usd)).toBeCloseTo(0.00012, 8);
    expect(call.rows[0]?.agent_identity).toBe("flight-agent");
    expect(call.rows[0]?.task_id).toBe(ids.taskId);
    expect(call.rows[0]?.trace_id).toBe(`trace-${ids.taskId}`);
    const control = await pool.query<{
      llm_attempts: number;
      reserved_cost_usd: string;
      actual_cost_usd: string;
    }>(
      `SELECT llm_attempts, reserved_cost_usd, actual_cost_usd FROM odft_app.protocol_task_control
        WHERE agent_identity = 'flight-agent' AND task_id = $1`,
      [ids.taskId],
    );
    expect(control.rows[0]?.llm_attempts).toBe(1);
    expect(Number(control.rows[0]?.reserved_cost_usd)).toBe(0);
    expect(Number(control.rows[0]?.actual_cost_usd)).toBeCloseTo(0.00012, 8);
  }, 60_000);

  it("falls back to the deterministic order for an invalid ranking", async () => {
    const ids = await seedPaidTask();
    const result: DelegatedFlightRankingResult = await ranker(
      scriptedAdapter({
        rankedOfferIds: ["combo-a", "combo-a", "invented"],
        reasons: [],
        tradeoffs: [],
      }),
    ).rank(rankingInput(ids));
    expect(result.fallbackUsed).toBe(true);
    expect(result.rankedOfferIds).toEqual(["combo-b", "combo-a"]);
    const call = await pool.query<{ status: string; validation_status: string }>(
      `SELECT status, validation_status FROM odft_app.llm_calls WHERE delegation_id = $1`,
      [ids.delegationId],
    );
    expect(call.rows[0]?.validation_status).toBe("invalid");
    expect(call.rows[0]?.status).toBe("failed");
  }, 60_000);

  it("keeps an uncertain paid call reserved and counted", async () => {
    const ids = await seedPaidTask();
    await expect(
      ranker(
        scriptedAdapter(undefined, {
          fail: new AdapterError("AI_TRANSPORT_FAILED", "socket closed", true),
        }),
      ).rank(rankingInput(ids)),
    ).rejects.toBeInstanceOf(AdapterError);
    const call = await pool.query<{
      status: string;
      cost_status: string;
      reserved_cost_usd: string;
    }>(
      `SELECT status, cost_status, reserved_cost_usd FROM odft_app.llm_calls WHERE delegation_id = $1`,
      [ids.delegationId],
    );
    expect(call.rows[0]?.status).toBe("unknown_reserved");
    expect(call.rows[0]?.cost_status).toBe("unknown_reserved");
    const control = await pool.query<{ reserved_cost_usd: string }>(
      `SELECT reserved_cost_usd FROM odft_app.protocol_task_control
        WHERE agent_identity = 'flight-agent' AND task_id = $1`,
      [ids.taskId],
    );
    expect(Number(control.rows[0]?.reserved_cost_usd)).toBeCloseTo(0.0022, 6);
    // The unknown reservation keeps counting against the shared trip cap.
    const next = await seedPaidTask();
    await expect(
      ranker(
        scriptedAdapter({ rankedOfferIds: ["combo-a", "combo-b"], reasons: [], tradeoffs: [] }),
      ).rank(
        rankingInput(next, {
          limits: { ...limits, maxCostUsdPerTrip: "0.0025" },
        }),
      ),
    ).rejects.toMatchObject({ name: "DelegatedCallError", code: "AI_BUDGET_EXCEEDED" });
  }, 60_000);

  it("serializes concurrent same-scope reservations into one winner", async () => {
    const ids = await seedPaidTask();
    const adapter = scriptedAdapter({
      rankedOfferIds: ["combo-a", "combo-b"],
      reasons: [],
      tradeoffs: [],
    });
    // Two concurrent attempts of the same task/scope: the per-scope attempt
    // bound (1) plus the shared trip row lock must let exactly one reservation
    // through — never two, and never a deadlock.
    const shared = {
      effectScope: "recommendation:shared",
      limits: { ...limits, maxAttemptsPerScope: 1 },
    };
    const results = await Promise.allSettled([
      ranker(adapter).rank(rankingInput(ids, shared)),
      ranker(adapter).rank(rankingInput(ids, shared)),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0] as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({
      name: "DelegatedCallError",
      code: "AI_BUDGET_EXCEEDED",
    });
  }, 60_000);

  it("ranks a hotel context through the generic delegated offer ranker", async () => {
    // Phase 06: the same generic ranker serves the accommodation comparison
    // (recommendation role, hotel target) with identical governance.
    const ids = await seedPaidTask();
    const hotels = [
      {
        offerId: "hotel-a",
        partyTotalMinor: 20_000,
        level: "standard" as const,
        centerDistanceKm: 1.2,
      },
      {
        offerId: "hotel-b",
        partyTotalMinor: 24_000,
        level: "standard" as const,
        centerDistanceKm: 0.4,
      },
    ];
    const result = await rankDelegatedOffers(
      pool,
      testServerConfig(),
      {
        paidAdapter: scriptedAdapter({
          rankedOfferIds: ["hotel-b", "hotel-a"],
          reasons: [{ offerId: "hotel-b", explanation: "closer to the centre" }],
          tradeoffs: [],
        }),
        paidProfile: profile,
      },
      {
        authority: {
          kind: "delegation",
          delegationId: ids.delegationId,
          agentIdentity: "flight-agent",
          skillId: "accommodation.recommend.v1",
          taskId: ids.taskId,
          traceId: `trace-${ids.taskId}`,
        },
        effectScope: "recommendation:hotel",
        limits,
        rolePrompt: { promptVersion: "recommendation-v1", systemPrompt: "rank the hotels" },
        context: {
          role: "recommendation",
          tradeoff: "closest to the centre first, then price",
          target: "hotel",
          baselineOfferId: null,
          candidates: hotels,
        },
        allowedIds: hotels.map((hotel) => hotel.offerId),
        deterministicOrder: ["hotel-a", "hotel-b"],
      },
    );
    expect(result.mode).toBe("openrouter");
    expect(result.fallbackUsed).toBe(false);
    expect(result.rankedOfferIds).toEqual(["hotel-b", "hotel-a"]);
    const call = await pool.query<{
      status: string;
      validation_status: string;
      prompt_version: string;
    }>(
      `SELECT status, validation_status, prompt_version FROM odft_app.llm_calls WHERE delegation_id = $1`,
      [ids.delegationId],
    );
    expect(call.rows[0]?.status).toBe("succeeded");
    expect(call.rows[0]?.validation_status).toBe("valid");
    expect(call.rows[0]?.prompt_version).toBe("recommendation-v1");
  }, 60_000);

  it("propagates the governance code of a revoked delegation verbatim", async () => {
    const ids = await seedPaidTask();
    await pool.query(
      `UPDATE odft_app.agent_delegations SET status = 'revoked', revoked_at = now() WHERE id = $1`,
      [ids.delegationId],
    );
    await expect(
      ranker(
        scriptedAdapter({ rankedOfferIds: ["combo-a", "combo-b"], reasons: [], tradeoffs: [] }),
      ).rank(rankingInput(ids)),
    ).rejects.toMatchObject({ name: "DelegatedCallError", code: "DELEGATION_REVOKED" });
  }, 60_000);
});
