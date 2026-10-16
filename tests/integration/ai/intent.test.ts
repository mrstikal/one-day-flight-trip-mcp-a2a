import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tripPreferencesSchema } from "@odft/contracts";
import {
  admitOperation,
  admitResume,
  applyTripCommands,
  getPendingDecisionForTrip,
  listConversation,
  TripCommandError,
} from "@odft/persistence";
import {
  approvePendingItinerary,
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createTravelDriver,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  resetGraphDatabase,
  resolveProgramChoices,
  sendChat,
  tripRevision,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-AI-01 / AC-08-3,4,5: a fixture chat message becomes a validated intent,
 * applies through the deterministic dispatcher, and persists bounded
 * conversation — with zero billable LLM rows (T-IT-LIM-03).
 */

describe("chat intent pipeline (real PostgreSQL)", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  async function preferences(tripId: string) {
    const result = await pool.query<{ preferences: unknown }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    return tripPreferencesSchema.parse(result.rows[0]?.preferences);
  }

  /** Confirmed reservation identity, used to prove a search changed nothing. */
  async function confirmedReservations(
    tripId: string,
  ): Promise<{ serviceKey: string; demoReference: string }[]> {
    const result = await pool.query<{ service_key: string; demo_reference: string }>(
      `SELECT service_key, demo_reference FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed' ORDER BY service_key`,
      [tripId],
    );
    return result.rows.map((row) => ({
      serviceKey: row.service_key,
      demoReference: row.demo_reference,
    }));
  }

  /** Choose one offered clarification/recovery option and run the resume. */
  async function choosePendingOption(
    tripId: string,
    sessionId: string,
    optionId: string,
  ): Promise<void> {
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    const admitted = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        decisionId: decision?.id ?? "",
        response: { action: "choose_option", optionId } as never,
      },
    });
    if (!("operationId" in admitted)) {
      throw new Error(`option choice refused: ${JSON.stringify(admitted)}`);
    }
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
  }

  it("applies a pace request without touching bookings or counts", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    const reservationsBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );

    await sendChat(pool, pools, tripId, sessionId, "Make the day less exhausting");

    const prefs = await preferences(tripId);
    expect(prefs.activityPace).toBe("relaxed");
    // AC-08-4: pace does not accidentally set a numeric count requirement.
    expect(prefs.minimumActivityCounts.museum).toBeUndefined();

    const reservationsAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    expect(reservationsAfter.rows[0]?.count).toBe(reservationsBefore.rows[0]?.count);

    // AC-08-1: user and assistant messages are persisted with the interpretation.
    const conversation = await listConversation(pool, tripId, 20);
    const user = conversation.find((message) => message.role === "user");
    const assistant = conversation.find((message) => message.role === "assistant");
    expect(user?.content).toBe("Make the day less exhausting");
    expect(assistant).toBeTruthy();
    expect(assistant?.interpretation).toMatchObject({ kind: "commands" });
    expect(JSON.stringify(assistant?.interpretation)).toContain("relaxed pace");

    // T-IT-LIM-03: fixture mode performs zero billable LLM calls.
    const calls = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.llm_calls WHERE trip_id = $1`,
      [tripId],
    );
    expect(calls.rows[0]?.count).toBe("0");
  }, 90_000);

  it("keeps a numeric count absolute and independent of pace", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    await sendChat(pool, pools, tripId, sessionId, "Add two more museums");
    let prefs = await preferences(tripId);
    // Relative counts resolve against the CURRENT plan: the deterministic harness
    // program contains one museum-tagged activity, so "two more" means 3.
    expect(prefs.minimumActivityCounts.museum).toBe(3);
    expect(prefs.activityPace).toBe("moderate");

    // The chat re-derived the program decision. The Rome inventory holds only
    // two museum-tagged activities, so the 3-museum request is infeasible: the
    // Phase 10 bounded loop opens a clarification that preserves the typed
    // numeric requirement, and nothing is reduced silently.
    const afterProgram = await resolveProgramChoices(pool, pools, tripId, sessionId);
    expect(afterProgram).toBe("clarification");
    const clarification = await getPendingDecisionForTrip(pools.operations, tripId);
    const payload = await pool.query<{ option_payload: unknown }>(
      `SELECT option_payload FROM odft_app.pending_decisions WHERE id = $1`,
      [clarification?.id],
    );
    const options =
      (payload.rows[0]?.option_payload as { options?: { id: string; label: string }[] })?.options ??
      [];
    expect(options.map((option) => option.id)).toContain("review_program");
    const reduce = options.find((option) => option.id.startsWith("reduce_"));
    expect(reduce?.label).toContain("reduce the minimum museum visits to 2");
    prefs = await preferences(tripId);
    expect(prefs.minimumActivityCounts.museum).toBe(3);

    // The user explicitly accepts the feasible reduction, which replans.
    await choosePendingOption(tripId, sessionId, reduce?.id as string);
    await approvePendingItinerary(pool, pools, tripId, sessionId);
    prefs = await preferences(tripId);
    expect(prefs.minimumActivityCounts.museum).toBe(2);

    // AC-08-5: the absolute requirement survives the pace change.
    await sendChat(pool, pools, tripId, sessionId, "Make the day less exhausting");
    prefs = await preferences(tripId);
    expect(prefs.minimumActivityCounts.museum).toBe(2);
    expect(prefs.activityPace).toBe("relaxed");
  }, 120_000);

  it("asks a bounded clarification for an ambiguous request and offers typed options", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    await sendChat(pool, pools, tripId, sessionId, "Make it cheaper");

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("clarification");
    expect((decision?.allowedOptionIds ?? []).length).toBeGreaterThanOrEqual(2);

    const payload = await pool.query<{ option_payload: unknown }>(
      `SELECT option_payload FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending'`,
      [tripId],
    );
    const options = (payload.rows[0]?.option_payload as { options?: { id: string; label: string }[] })
      ?.options;
    expect(options?.length).toBeGreaterThanOrEqual(2);
    expect(options?.every((option) => option.label.length > 0)).toBe(true);
    expect(options?.every((option) => !("commands" in option))).toBe(true);
  }, 90_000);

  it("returns a scripted limitation for unsupported input without failing the trip", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    await sendChat(pool, pools, tripId, sessionId, "Please invent a moon flight");

    const trip = await pool.query<{ workflow_status: string }>(
      `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.workflow_status).toBe("ready");
    const conversation = await listConversation(pool, tripId, 20);
    expect(
      conversation.some(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.interpretation).includes("unsupported"),
      ),
    ).toBe(true);
  }, 90_000);

  it("stores the user message inside the admission transaction (P2-5)", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);
    const message = "Make the day less exhausting";
    const admitted = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        chat: message,
      },
      userMessage: message,
    });
    expect("status" in admitted && admitted.status === "accepted").toBe(true);
    // The message exists BEFORE the worker ever claims the operation.
    const conversation = await listConversation(pool, tripId, 10);
    expect(conversation.some((entry) => entry.role === "user" && entry.content === message)).toBe(true);
  }, 90_000);

  it("applies a command batch atomically and refuses the whole batch on a route change with a booking (P2-1)", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);
    const before = await preferences(tripId);
    const confirmed = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    expect(Number(confirmed.rows[0]?.count ?? "0")).toBeGreaterThan(0);

    await expect(
      applyTripCommands(pool, {
        tripId,
        commands: [
          { type: "set_budget", maxBudgetMinor: 123_400 },
          { type: "set_route", sightseeingDate: "2026-12-05" },
        ],
      }),
    ).rejects.toBeInstanceOf(TripCommandError);

    // The first command must NOT survive the refused batch.
    const after = await preferences(tripId);
    expect(after.maxBudgetMinor).toBe(before.maxBudgetMinor);
  }, 90_000);

  it("runs a search-only request as a targeted refresh of the searched domain (P11-2)", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    const reservationsBefore = await confirmedReservations(tripId);
    await sendChat(pool, pools, tripId, sessionId, "Find a cheaper hotel");

    // Phase 11: the search refreshes the searched domain and presents the
    // refreshed alternatives; no confirmed reservation changed and no booking
    // was touched (the hotel stays active until an explicit confirmation).
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("hotel_choice");
    expect(await confirmedReservations(tripId)).toEqual(reservationsBefore);
    const conversation = await listConversation(pool, tripId, 20);
    const assistant = conversation.find((entry) => entry.role === "assistant");
    expect(assistant?.content).toContain("No confirmed reservation was changed");
  }, 90_000);

  it("reuses the validated interpretation effect on replay (no second call)", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);
    const { operationId } = await sendChat(
      pool,
      pools,
      tripId,
      sessionId,
      "Make the day less exhausting",
    );

    const ai = createTestAiService(pools);
    const token = await pool.query<{ fencing_token: string }>(
      `SELECT fencing_token FROM odft_app.workflow_operations WHERE id = $1`,
      [operationId],
    );
    const fencingToken = token.rows[0]?.fencing_token ?? "1";
    const before = ai.fixtureCounters?.().calls ?? 0;
    const first = await ai.interpret({
      tripId,
      operationId,
      fencingToken,
      message: "Make the day less exhausting",
    });
    const second = await ai.interpret({
      tripId,
      operationId,
      fencingToken,
      message: "Make the day less exhausting",
    });
    const after = ai.fixtureCounters?.().calls ?? 0;
    // The effect ledger served both replays; the adapter was not invoked again.
    expect(after).toBe(before);
    expect(first.result).toEqual(second.result);
    expect(first.result.kind).toBe("commands");
  }, 90_000);
});
