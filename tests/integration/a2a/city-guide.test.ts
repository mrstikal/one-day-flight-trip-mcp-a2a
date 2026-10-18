import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { upsertFault } from "@odft/persistence";
import { A2AClient } from "@odft/protocols";
import {
  cityGuideAgentClientConfig,
  cityGuideAgentDatabaseUrl,
  createCityGuideDelegation,
  dataMessage,
  agentTaskRequestData,
  startCityGuideAgent,
  stopAgent,
  waitForAgentReady,
} from "./_setup-agents.js";
import {
  createMcpTestPool,
  createMcpTestWorkerPools,
  endWorkerPools,
  resetMcpDatabase,
  seedDelegatedSnapshot,
  setupProtocolRoles,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
  type SeededSnapshot,
  type WorkerPools,
} from "./_setup.js";

/**
 * Phase 06 City Guide agent: exact requested-domain outcomes, deterministic
 * ranking membership, retained partial successes when one domain fails, and the
 * delegation-scope refusal outside the authorized domains.
 */

let pool: Pool;
let pools: WorkerPools;
let mcpHost: ChildProcess;
let agent: ChildProcess;
let seeded: SeededSnapshot;

async function send(data: unknown): Promise<Task> {
  const client = new A2AClient({ config: cityGuideAgentClientConfig() });
  const result = await client.sendMessage("city-guide-agent", {
    message: dataMessage(data),
    tenant: "",
    configuration: undefined,
    metadata: undefined,
  });
  if (!("status" in result)) {
    throw new Error("expected a task result");
  }
  return result as Task;
}

function artifactOf(task: Task, name: string): unknown {
  const artifact = task.artifacts?.find((entry) => entry.name === name);
  const part = artifact?.parts?.find(
    (candidate) => candidate.content?.$case === "data" && candidate.content.value !== undefined,
  );
  return part && part.content?.$case === "data" ? part.content.value : undefined;
}

function cityGuideRequest(delegationId: string, requestedDomains: string[]): unknown {
  return agentTaskRequestData({
    skillId: "city-guide.research.v1",
    tripId: seeded.tripId,
    operationId: seeded.operationId,
    delegationId,
    snapshotId: seeded.snapshotId,
    scenarioKey: "seeded",
    requestedDomains,
  });
}

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  seeded = await seedDelegatedSnapshot(pool, pools);
  mcpHost = startMcpHost();
  await waitForHostReady(mcpHost);
  agent = startCityGuideAgent();
  await waitForAgentReady(agent, "city-guide-agent");
}, 120_000);

afterAll(async () => {
  await stopAgent(agent);
  await stopMcpHost(mcpHost);
  await endWorkerPools(pools);
  await pool.end();
});

describe("city guide agent", () => {
  it("returns exactly the requested domains with ranked existing ids", async () => {
    const delegationId = await createCityGuideDelegation(pool, seeded);
    const task = await send(cityGuideRequest(delegationId, ["breakfast", "attractions", "events"]));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const artifact = artifactOf(task, "city-guide-recommendations") as {
      outcomes: { domain: string; status: string; rankedOfferIds: string[] }[];
      correlation: { domainFingerprints: Record<string, string> };
    };
    expect(artifact.outcomes.map((outcome) => outcome.domain)).toEqual([
      "breakfast",
      "attractions",
      "events",
    ]);
    for (const outcome of artifact.outcomes) {
      expect(outcome.status).toBe("ok");
      expect(outcome.rankedOfferIds.length).toBeGreaterThan(0);
    }
    // Membership: every ranked breakfast id exists in the seeded snapshot.
    const breakfastOutcome = artifact.outcomes[0];
    const snapshotRestaurants = await pool.query<{ ids: string[] }>(
      `SELECT jsonb_agg(r->>'id') AS ids
         FROM odft_app.scenario_snapshots s, lateral jsonb_array_elements(s.inventory->'restaurants') r
        WHERE s.id = $1 AND r->>'meal' = 'breakfast'`,
      [seeded.snapshotId],
    );
    const seededIds = new Set(snapshotRestaurants.rows[0]?.ids ?? []);
    expect(seededIds.size).toBeGreaterThan(0);
    expect(breakfastOutcome?.rankedOfferIds.length).toBeGreaterThan(0);
    for (const id of breakfastOutcome?.rankedOfferIds ?? []) {
      expect(seededIds.has(id)).toBe(true);
    }
    expect(artifact.correlation.domainFingerprints["breakfast"]).toMatch(/^[a-f0-9]{64}$/);
  }, 90_000);

  it("retains partial successes when one domain fails (no all-success barrier)", async () => {
    const delegationId = await createCityGuideDelegation(pool, seeded);
    // Provider failure on the breakfast provider (attempt 1): that domain
    // becomes a labeled retryable error while its siblings stay available.
    await upsertFault(pool, {
      tripId: seeded.tripId,
      domain: "breakfast",
      fault: "provider_failure",
    });
    try {
      const task = await send(
        cityGuideRequest(delegationId, ["breakfast", "lunch", "attractions"]),
      );
      expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      const artifact = artifactOf(task, "city-guide-recommendations") as {
        outcomes: {
          domain: string;
          status: string;
          rankedOfferIds: string[];
          simulatedFailure: boolean;
        }[];
        findings: { code: string }[];
      };
      const byDomain = new Map(artifact.outcomes.map((outcome) => [outcome.domain, outcome]));
      expect(byDomain.get("lunch")?.status).toBe("ok");
      expect(byDomain.get("attractions")?.status).toBe("ok");
      expect(byDomain.get("breakfast")?.status).toBe("retryable_error");
      expect(byDomain.get("breakfast")?.simulatedFailure).toBe(true);
      expect(byDomain.get("lunch")?.rankedOfferIds.length).toBeGreaterThan(0);
      expect(
        artifact.findings.some((finding) => finding.code === "CITY_GUIDE_RETRYABLE_ERROR"),
      ).toBe(true);
    } finally {
      await pool.query(`DELETE FROM odft_app.simulation_faults WHERE trip_id = $1`, [
        seeded.tripId,
      ]);
    }
  }, 90_000);

  it("records an explicit unsupported outcome for a domain outside its skill", async () => {
    const delegationId = await createCityGuideDelegation(pool, seeded, {
      domains: ["breakfast", "hotel"],
    });
    const task = await send(cityGuideRequest(delegationId, ["breakfast", "hotel"]));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const artifact = artifactOf(task, "city-guide-recommendations") as {
      outcomes: { domain: string; status: string }[];
    };
    // The requested hotel domain is preserved as an explicit unsupported
    // outcome (never queried, never silently dropped).
    expect(artifact.outcomes.map((outcome) => outcome.domain)).toEqual(["breakfast", "hotel"]);
    expect(artifact.outcomes[1]?.status).toBe("unsupported");
  }, 60_000);

  it("refuses a requested domain outside the delegated scope", async () => {
    const delegationId = await createCityGuideDelegation(pool, seeded, { domains: ["breakfast"] });
    const task = await send(cityGuideRequest(delegationId, ["breakfast", "dinner"]));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const message =
      task.status?.message?.parts?.[0]?.content?.$case === "text"
        ? task.status.message.parts[0].content.value
        : "";
    expect(message).toMatch(/dinner/);
    expect(task.artifacts ?? []).toHaveLength(0);
  }, 60_000);

  it("proves the city-guide role cannot mutate trip state or book", async () => {
    const delegationId = await createCityGuideDelegation(pool, seeded);
    const agentPool = new Pool({ connectionString: cityGuideAgentDatabaseUrl(), max: 1 });
    try {
      await expect(
        agentPool.query(`UPDATE odft_app.trips SET revision = revision + 1 WHERE id = $1`, [
          seeded.tripId,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        agentPool.query(`UPDATE odft_app.agent_delegations SET status = 'revoked' WHERE id = $1`, [
          delegationId,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        agentPool.query(
          `INSERT INTO odft_app.trip_selections (trip_id, service_key, offer_id) VALUES ($1, 'dinner', 'x')`,
          [seeded.tripId],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        agentPool.query(
          `INSERT INTO odft_app.reservations (id, trip_id, service_key, offer_id, status)
           VALUES (gen_random_uuid(), $1, 'dinner', 'x', 'confirmed')`,
          [seeded.tripId],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await agentPool.end();
    }
  }, 30_000);
});
