import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";
import { Role } from "@a2a-js/sdk";
import type { Message } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import {
  DurableMessageAdmission,
  MessageConflictError,
  ServiceInstanceLock,
  buildObservation,
  createTaskStore,
  AGENT_TASK_TABLES,
} from "@odft/protocols";
import {
  createTrip,
  insertAgentDelegation,
  insertCoordinatorRun,
  insertDecision,
  insertOutboundMessage,
  insertProtocolObservation,
  linkObservationToEvent,
  listUnlinkedObservations,
  loadValidatedOutput,
  runMigrations,
  saveValidatedOutput,
} from "@odft/persistence";
import { createFixtureSession } from "../../fixtures/session.js";
import { fixtureCreationInput } from "../../fixtures/trip.js";
import { createTestPool, resetProtocolDatabase } from "./_setup.js";

/**
 * Phase 03 protocol persistence tests: migration repeatability, durable
 * admission transactionality/dedupe/reconciliation, engine-aware decision
 * constraints, outbound dedupe and safe observations — all against real
 * PostgreSQL with the official SDK task tables.
 */

let pool: Pool;
let db: Kysely<unknown>;
let serviceLock: ServiceInstanceLock;

beforeAll(async () => {
  pool = createTestPool();
  await resetProtocolDatabase(pool);
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  serviceLock = await ServiceInstanceLock.acquire(pool, "flight-agent");
});

afterAll(async () => {
  await serviceLock.release();
  // Kysely's destroy ends the pg pool it was given.
  await db.destroy();
});

function userContext(agentIdentity = "flight-agent"): ServerCallContext {
  return new ServerCallContext({
    user: {
      get isAuthenticated(): boolean {
        return true;
      },
      get userName(): string {
        return agentIdentity;
      },
    },
  });
}

function fixtureMessage(messageId: string = randomUUID(), text = "echo"): Message {
  return {
    messageId,
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        mediaType: "text/plain",
        filename: "",
        metadata: {},
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

describe("migration 0013", () => {
  it("is repeatable: a second run applies nothing", async () => {
    const second = await runMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain("0013-protocol-state");
  });

  it("creates the official SDK task tables in the protocol schema", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'odft_protocol' AND table_name LIKE 'agent_tasks_%'
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "agent_tasks_accommodation",
      "agent_tasks_accommodation_alt",
      "agent_tasks_city_guide",
      "agent_tasks_flight",
    ]);
  });
});

describe("durable inbound admission", () => {
  it("commits the canonical task, mapping and control row before work, then replays duplicates", async () => {
    const admission = new DurableMessageAdmission(db, {
      agentIdentity: "flight-agent",
      taskTable: AGENT_TASK_TABLES.flight,
    });
    const message = fixtureMessage();
    const first = await admission.admit(message, userContext());
    expect(first.kind).toBe("admitted");
    expect(first.taskId).toMatch(/^[0-9a-f-]{36}$/);

    const store = createTaskStore(db, {
      tableName: AGENT_TASK_TABLES.flight,
      owner: "flight-agent",
    });
    const stored = await store.load(first.taskId, userContext());
    expect(stored?.status?.state).toBe(1); // TASK_STATE_SUBMITTED

    const control = await pool.query<{ state: string }>(
      `SELECT state FROM odft_app.protocol_task_control WHERE agent_identity = 'flight-agent' AND task_id = $1`,
      [first.taskId],
    );
    expect(control.rows[0]?.state).toBe("submitted");

    const replay = await admission.admit(message, userContext());
    expect(replay.kind).toBe("replay");
    expect(replay.taskId).toBe(first.taskId);

    const conflicting = fixtureMessage(String(message.messageId), "different payload");
    await expect(admission.admit(conflicting, userContext())).rejects.toBeInstanceOf(
      MessageConflictError,
    );
  });

  it("resolves concurrent duplicate admissions to exactly one canonical task", async () => {
    const admission = new DurableMessageAdmission(db, {
      agentIdentity: "flight-agent",
      taskTable: AGENT_TASK_TABLES.flight,
    });
    const message = fixtureMessage();
    const [a, b] = await Promise.all([
      admission.admit(message, userContext()),
      admission.admit(message, userContext()),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["admitted", "replay"]);
    expect(a.taskId).toBe(b.taskId);
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_protocol.agent_tasks_flight WHERE id = $1`,
      [a.taskId],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("reconciles tasks a stopped process left active into explicit restart failures", async () => {
    const admission = new DurableMessageAdmission(db, {
      agentIdentity: "flight-agent",
      taskTable: AGENT_TASK_TABLES.flight,
    });
    const message = fixtureMessage();
    const admitted = await admission.admit(message, userContext());
    await admission.markWorking(admitted.taskId);

    const reconciled = await admission.reconcileRestartedTasks(serviceLock);
    expect(reconciled).toContain(admitted.taskId);

    const store = createTaskStore(db, {
      tableName: AGENT_TASK_TABLES.flight,
      owner: "flight-agent",
    });
    const stored = await store.load(admitted.taskId, userContext());
    expect(stored?.status?.state).toBe(4); // TASK_STATE_FAILED

    // A duplicate now replays the failed task instead of starting new work.
    const replay = await admission.admit(message, userContext());
    expect(replay.kind).toBe("replay");
    expect(replay.kind === "replay" ? replay.task?.status?.state : undefined).toBe(4);
  });

  it("keeps an existing task untouched when a continuation is admitted", async () => {
    const admission = new DurableMessageAdmission(db, {
      agentIdentity: "flight-agent",
      taskTable: AGENT_TASK_TABLES.flight,
    });
    const first = await admission.admit(fixtureMessage(), userContext());
    expect(first.kind).toBe("admitted");

    const store = createTaskStore(db, {
      tableName: AGENT_TASK_TABLES.flight,
      owner: "flight-agent",
    });
    // Simulate the SDK finishing the first turn: artifacts + terminal status.
    const stored = await store.load(first.taskId, userContext());
    if (!stored) {
      throw new Error("task fixture missing");
    }
    await store.save(
      {
        ...stored,
        status: { state: 3, message: undefined, timestamp: new Date().toISOString() },
        artifacts: [
          {
            artifactId: "artifact-1",
            name: "kept",
            description: "",
            parts: [],
            metadata: undefined,
            extensions: [],
          },
        ],
      },
      userContext(),
    );

    const continuation = await admission.admit(
      {
        ...fixtureMessage(randomUUID(), "continuation"),
        taskId: first.taskId,
        contextId: first.contextId,
      },
      userContext(),
    );
    expect(continuation.kind).toBe("continuation");
    const after = await store.load(first.taskId, userContext());
    expect(after?.artifacts[0]?.artifactId).toBe("artifact-1");
    expect(after?.status?.state).toBe(3);
    const control = await pool.query<{ state: string; input_generation: number }>(
      `SELECT state, input_generation FROM odft_app.protocol_task_control
        WHERE agent_identity = 'flight-agent' AND task_id = $1`,
      [first.taskId],
    );
    expect(control.rows[0]?.state).toBe("working");
    expect(control.rows[0]?.input_generation).toBe(2);
  });

  it("answers TaskNotFound-shaped errors for unknown task ids without claiming the message", async () => {
    const admission = new DurableMessageAdmission(db, {
      agentIdentity: "flight-agent",
      taskTable: AGENT_TASK_TABLES.flight,
    });
    const message = { ...fixtureMessage(), taskId: randomUUID(), contextId: randomUUID() };
    await expect(admission.admit(message, userContext())).rejects.toThrow(/is unknown/);
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.protocol_inbound_messages WHERE message_id = $1`,
      [message.messageId],
    );
    expect(rows.rows[0]?.count).toBe("0");
  });
});

describe("engine-aware decisions and coordinator runs", () => {
  async function seedTrip(): Promise<string> {
    const client = await pool.connect();
    let sessionId: string;
    try {
      sessionId = await createFixtureSession(client);
    } finally {
      client.release();
    }
    const created = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
    if (!("tripId" in created)) {
      throw new Error(`trip fixture failed: ${created.code}`);
    }
    return created.tripId;
  }

  it("stores a coordinator decision bound to its run and rejects graph ids", async () => {
    const tripId = await seedTrip();
    // Reuse the creation operation committed by createTrip: a second active
    // operation for the same trip is refused by the one-active-operation index.
    const operation = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1 ORDER BY created_at LIMIT 1`,
      [tripId],
    );
    const operationId = operation.rows[0]?.id;
    if (!operationId) {
      throw new Error("trip creation operation missing");
    }
    const run = await insertCoordinatorRun(pool, {
      tripId,
      operationId,
      acceptedRevision: 1,
      step: "interpreting",
      runData: { schemaVersion: 1, affectedDomains: [], expectedFingerprints: {} },
    });
    const decisionId = await insertDecision(pool, {
      tripId,
      kind: "agent_input",
      engine: "coordinator-v1",
      coordinatorRunId: run.id,
      createdRevision: 1,
      sourceFingerprint: "b".repeat(64),
      payloadHash: "c".repeat(64),
      allowedOptionIds: ["option-a", "option-b"],
      optionPayload: { requestId: "q-1" },
    });
    const row = await pool.query<{ engine: string; coordinator_run_id: string }>(
      `SELECT engine, coordinator_run_id FROM odft_app.pending_decisions WHERE id = $1`,
      [decisionId],
    );
    expect(row.rows[0]?.engine).toBe("coordinator-v1");
    expect(row.rows[0]?.coordinator_run_id).toBe(run.id);

    await expect(
      insertDecision(pool, {
        tripId,
        kind: "clarification",
        engine: "coordinator-v1",
        coordinatorRunId: run.id,
        threadId: "thread-1",
        graphVersion: "travel-graph-v7",
        createdRevision: 1,
        sourceFingerprint: "d".repeat(64),
        payloadHash: "e".repeat(64),
      }),
    ).rejects.toThrow(/pending_decisions_engine_binding_check/);
  });

  it("keeps graph decisions valid without a coordinator run", async () => {
    const tripId = await seedTrip();
    const decisionId = await insertDecision(pool, {
      tripId,
      kind: "clarification",
      engine: "langgraph",
      threadId: "thread-1",
      graphVersion: "travel-graph-v7",
      createdRevision: 0,
      sourceFingerprint: "f".repeat(64),
      payloadHash: "0".repeat(64),
    });
    const row = await pool.query<{ engine: string }>(
      `SELECT engine FROM odft_app.pending_decisions WHERE id = $1`,
      [decisionId],
    );
    expect(row.rows[0]?.engine).toBe("langgraph");
  });
});

describe("delegations, outbound dedupe and validated outputs", () => {
  async function seedDelegation(): Promise<string> {
    const client = await pool.connect();
    let sessionId: string;
    try {
      sessionId = await createFixtureSession(client);
    } finally {
      client.release();
    }
    const created = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
    if (!("tripId" in created)) {
      throw new Error(`trip fixture failed: ${created.code}`);
    }
    const operation = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1 ORDER BY created_at LIMIT 1`,
      [created.tripId],
    );
    const operationId = operation.rows[0]?.id;
    if (!operationId) {
      throw new Error("trip creation operation missing");
    }
    const delegation = await insertAgentDelegation(pool, {
      tripId: created.tripId,
      originatingOperationId: operationId,
      acceptedRevision: 1,
      skillId: "flight.recommend.v1",
      agentIdentity: "flight-agent",
      endpointUrl: "http://127.0.0.1:4311",
      snapshotId: randomUUID(),
      inputFingerprint: "2".repeat(64),
      scope: { domains: ["hotel"] },
    });
    return delegation.id;
  }

  it("rejects a repeated outbound message id with a different payload hash", async () => {
    const delegationId = await seedDelegation();
    const first = await insertOutboundMessage(pool, {
      delegationId,
      messageId: "msg-1",
      payloadHash: "3".repeat(64),
      payload: { kind: "task", body: "one" },
    });
    expect(first.conflict).toBe(false);
    const same = await insertOutboundMessage(pool, {
      delegationId,
      messageId: "msg-1",
      payloadHash: "3".repeat(64),
      payload: { kind: "task", body: "one" },
    });
    expect(same.conflict).toBe(false);
    const conflicting = await insertOutboundMessage(pool, {
      delegationId,
      messageId: "msg-1",
      payloadHash: "4".repeat(64),
      payload: { kind: "task", body: "two" },
    });
    expect(conflicting.conflict).toBe(true);
  });

  it("caches validated outputs per task and artifact kind", async () => {
    const delegationId = await seedDelegation();
    await saveValidatedOutput(pool, {
      agentIdentity: "flight-agent",
      taskId: `task-${delegationId}`,
      artifactKind: "flight_recommendations",
      payloadHash: "5".repeat(64),
      payload: { rankedCombinationIds: ["combo-1"] },
      accepted: true,
    });
    const loaded = await loadValidatedOutput(pool, {
      agentIdentity: "flight-agent",
      taskId: `task-${delegationId}`,
      artifactKind: "flight_recommendations",
    });
    expect(loaded?.payloadHash).toBe("5".repeat(64));
    expect(loaded?.accepted).toBe(true);
  });
});

describe("safe observations", () => {
  it("persists sanitized observations and links them to events idempotently", async () => {
    const client = await pool.connect();
    let sessionId: string;
    try {
      sessionId = await createFixtureSession(client);
    } finally {
      client.release();
    }
    const trip = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
    if (!("tripId" in trip)) {
      throw new Error(`trip fixture failed: ${trip.code}`);
    }
    // Trip-less observations cannot bridge to an application event and are
    // intentionally excluded from the unlinked round; the correlation must
    // carry the trip id.
    const observation = buildObservation({
      source: "coordinator",
      kind: "card_discovery",
      correlation: { tripId: trip.tripId, traceId: "trace-1" },
      payload: { detail: "fetched  card\n  summary", status: "ok", counters: { attempts: 1 } },
    });
    const stored = await insertProtocolObservation(pool, observation);
    expect(stored.payload.detail).toBe("fetched card summary");
    const unlinked = await listUnlinkedObservations(pool);
    expect(unlinked.some((row) => row.id === stored.id)).toBe(true);

    const event = await pool.query<{ id: string }>(
      `INSERT INTO odft_app.execution_events (trip_id, type, payload)
       VALUES ($1, 'protocol.observation', '{}'::jsonb) RETURNING id`,
      [trip.tripId],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) {
      throw new Error("event fixture failed");
    }
    await linkObservationToEvent(pool, { observationId: stored.id, applicationEventId: eventId });
    // Idempotent: a second link attempt changes nothing.
    await linkObservationToEvent(pool, { observationId: stored.id, applicationEventId: eventId });
    const linked = await pool.query<{ application_event_id: string }>(
      `SELECT application_event_id FROM odft_app.protocol_observations WHERE id = $1`,
      [stored.id],
    );
    expect(linked.rows[0]?.application_event_id).toBe(eventId);
  });
});
