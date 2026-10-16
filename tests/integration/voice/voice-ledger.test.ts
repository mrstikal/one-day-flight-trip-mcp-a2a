import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countTripVoiceCalls,
  getVoiceCall,
  markVoiceCallFailed,
  markVoiceCallUnknown,
  reconcileVoiceCallBilling,
  reserveVoiceCall,
  settleVoiceCallSuccess,
  sumTripVoiceCostUsd,
  type ReserveVoiceCallInput,
} from "@odft/persistence";
import { createGraphTestPool, createHarnessTrip, resetGraphDatabase } from "../graph/_setup.js";

/**
 * T-IT-VOICE-04/05 (VOICE_CONTROLL.md section 15): real PostgreSQL proves
 * concurrent budget safety, duplicate-request behavior, and that an uncertain
 * charge survives restarts and is never auto-zeroed.
 */

const WHISPER = "openai/whisper-large-v3-turbo";

function reserveInput(
  tripId: string,
  overrides: Partial<ReserveVoiceCallInput> = {},
): ReserveVoiceCallInput {
  return {
    tripId,
    requestId: randomUUID(),
    requestFingerprint: "fingerprint-stt-1",
    kind: "stt",
    model: WHISPER,
    providerRestriction: "groq",
    unitKind: "audio_seconds",
    inputUnits: 10,
    reservedCostUsd: "0.004",
    maxCallCostUsd: "0.02",
    maxCallsPerTrip: 60,
    maxCostUsdPerTrip: "1.00",
    ...overrides,
  };
}

describe("voice-call ledger", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createGraphTestPool(8);
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshTrip(): Promise<string> {
    const { tripId } = await createHarnessTrip(pool);
    return tripId;
  }

  it("serializes concurrent reservations so the per-trip budget cannot be overspent", async () => {
    const tripId = await freshTrip();
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        reserveVoiceCall(
          pool,
          reserveInput(tripId, { reservedCostUsd: "0.004", maxCostUsdPerTrip: "0.01" }),
        ),
      ),
    );
    const accepted = attempts.filter((outcome) => outcome.ok);
    const refused = attempts.filter((outcome) => !outcome.ok);
    // 2 x 0.004 <= 0.01; the third reservation would exceed it.
    expect(accepted).toHaveLength(2);
    expect(refused).toHaveLength(3);
    for (const outcome of refused) {
      if (outcome.ok) {
        throw new Error("unreachable");
      }
      expect(outcome.code).toBe("VOICE_BUDGET_EXCEEDED");
    }
    expect(await countTripVoiceCalls(pool, tripId)).toBe(2);
    expect(await sumTripVoiceCostUsd(pool, tripId)).toBe(8_000_000n);
  });

  it("refuses a call above the per-call ceiling before writing anything", async () => {
    const tripId = await freshTrip();
    const outcome = await reserveVoiceCall(
      pool,
      reserveInput(tripId, { reservedCostUsd: "0.03", maxCallCostUsd: "0.02" }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("VOICE_BUDGET_EXCEEDED");
    }
    expect(await countTripVoiceCalls(pool, tripId)).toBe(0);
  });

  it("enforces the 60-call style attempt budget", async () => {
    const tripId = await freshTrip();
    const first = await reserveVoiceCall(
      pool,
      reserveInput(tripId, { maxCallsPerTrip: 2, reservedCostUsd: "0.0001" }),
    );
    const second = await reserveVoiceCall(
      pool,
      reserveInput(tripId, { maxCallsPerTrip: 2, reservedCostUsd: "0.0001" }),
    );
    const third = await reserveVoiceCall(
      pool,
      reserveInput(tripId, { maxCallsPerTrip: 2, reservedCostUsd: "0.0001" }),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.code).toBe("VOICE_BUDGET_EXCEEDED");
    }
  });

  it("treats a reused request id by its exact kind/fingerprint and never re-calls a finished request", async () => {
    const tripId = await freshTrip();
    const requestId = randomUUID();
    const first = await reserveVoiceCall(pool, reserveInput(tripId, { requestId }));
    expect(first.ok).toBe(true);

    const inProgress = await reserveVoiceCall(pool, reserveInput(tripId, { requestId }));
    expect(inProgress.ok).toBe(false);
    if (!inProgress.ok) {
      expect(inProgress.code).toBe("VOICE_REQUEST_IN_PROGRESS");
    }

    const conflicting = await reserveVoiceCall(
      pool,
      reserveInput(tripId, { requestId, requestFingerprint: "different-fingerprint" }),
    );
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.code).toBe("CONFLICT");
    }

    if (!first.ok) {
      throw new Error("expected the first reservation to succeed");
    }
    await settleVoiceCallSuccess(pool, first.callId, {
      costStatus: "actual",
      costUsd: "0.0005",
      latencyMs: 700,
      inputUnits: 9.2,
      unitKind: "audio_seconds",
      servingProviderId: "groq",
      generationId: "gen-1",
    });
    const settled = await getVoiceCall(pool, first.callId);
    expect(settled).toMatchObject({
      status: "succeeded",
      costStatus: "actual",
      actualCostUsd: "0.0005",
      servingProvider: "groq",
      generationId: "gen-1",
    });
    const finished = await reserveVoiceCall(pool, reserveInput(tripId, { requestId }));
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.code).toBe("VOICE_RESULT_EXPIRED");
    }
    expect(await countTripVoiceCalls(pool, tripId)).toBe(1);
  });

  it("keeps an uncertain charge reserved across a process restart and reconciles only explicitly", async () => {
    const tripId = await freshTrip();
    const reserved = await reserveVoiceCall(pool, reserveInput(tripId));
    if (!reserved.ok) {
      throw new Error("expected the reservation to succeed");
    }
    await markVoiceCallUnknown(pool, reserved.callId, { errorCode: "VOICE_TIMEOUT" });
    const unknown = await getVoiceCall(pool, reserved.callId);
    expect(unknown).toMatchObject({ status: "unknown_reserved", costStatus: "unknown_reserved" });
    expect(await sumTripVoiceCostUsd(pool, tripId)).toBe(4_000_000n);

    // A restart can only observe rows: the reservation is never auto-zeroed.
    const restarted = createGraphTestPool(2);
    try {
      expect(await sumTripVoiceCostUsd(restarted, tripId)).toBe(4_000_000n);
      expect(await countTripVoiceCalls(restarted, tripId)).toBe(1);
    } finally {
      await restarted.end();
    }

    // Reusing the request while uncertain still refuses a second provider call.
    const maybeAgain = await reserveVoiceCall(
      pool,
      reserveInput(tripId, { requestId: unknown?.requestId }),
    );
    expect(maybeAgain.ok).toBe(false);
    if (!maybeAgain.ok) {
      expect(maybeAgain.code).toBe("VOICE_REQUEST_IN_PROGRESS");
    }

    await reconcileVoiceCallBilling(pool, reserved.callId, {
      actualCostUsd: "0.0004",
      costStatus: "actual",
    });
    const reconciled = await getVoiceCall(pool, reserved.callId);
    expect(reconciled?.status).toBe("reconciled");
    expect(reconciled?.actualCostUsd).toBe("0.0004");
    expect(await sumTripVoiceCostUsd(pool, tripId)).toBe(400_000n);
    expect(await countTripVoiceCalls(pool, tripId)).toBe(1);
  });

  it("requires the message and operation links for a TTS reservation", async () => {
    const tripId = await freshTrip();
    await expect(
      reserveVoiceCall(
        pool,
        reserveInput(tripId, {
          kind: "tts",
          model: "elevenlabs/eleven-v4-turbo",
          unitKind: "characters",
          inputUnits: 42,
        }),
      ),
    ).rejects.toThrow(/tts reservation/);
    expect(await countTripVoiceCalls(pool, tripId)).toBe(0);
  });

  it("retains the reservation after an observed failure and guards terminal states", async () => {
    const tripId = await freshTrip();
    const reserved = await reserveVoiceCall(pool, reserveInput(tripId));
    if (!reserved.ok) {
      throw new Error("expected the reservation to succeed");
    }
    await markVoiceCallFailed(pool, reserved.callId, { errorCode: "VOICE_UPSTREAM_FAILED" });
    const failed = await getVoiceCall(pool, reserved.callId);
    expect(failed).toMatchObject({ status: "failed", actualCostUsd: null, costStatus: null });
    // The uncertain upstream charge is still counted at its reserved amount.
    expect(await sumTripVoiceCostUsd(pool, tripId)).toBe(4_000_000n);

    // A terminal row is never rewritten by a late success or a second failure.
    await expect(
      settleVoiceCallSuccess(pool, reserved.callId, {
        costStatus: "actual",
        costUsd: "0.001",
        latencyMs: 10,
      }),
    ).rejects.toThrow(/settleable/);
    await expect(
      markVoiceCallFailed(pool, reserved.callId, { errorCode: "VOICE_TIMEOUT" }),
    ).rejects.toThrow(/failure-markable/);

    // Reconciliation needs verified billing evidence and happens once.
    await expect(reconcileVoiceCallBilling(pool, reserved.callId, {})).rejects.toThrow(
      /billing evidence/,
    );
    await expect(
      reconcileVoiceCallBilling(pool, reserved.callId, { costStatus: "actual" }),
    ).rejects.toThrow(/actual USD amount/);
    await reconcileVoiceCallBilling(pool, reserved.callId, {
      actualCostUsd: "0.0002",
      costStatus: "actual",
    });
    await expect(
      reconcileVoiceCallBilling(pool, reserved.callId, { actualCostUsd: "0.0003" }),
    ).rejects.toThrow(/already reconciled/);
    expect(await sumTripVoiceCostUsd(pool, tripId)).toBe(200_000n);
  });

  it("keeps the budget isolated per trip and accepts an explicit no-units reservation", async () => {
    const firstTrip = await freshTrip();
    const secondTrip = await freshTrip();
    const limited = await reserveVoiceCall(
      pool,
      reserveInput(firstTrip, { reservedCostUsd: "0.009", maxCostUsdPerTrip: "0.01" }),
    );
    expect(limited.ok).toBe(true);
    const exhausted = await reserveVoiceCall(
      pool,
      reserveInput(firstTrip, { reservedCostUsd: "0.009", maxCostUsdPerTrip: "0.01" }),
    );
    expect(exhausted.ok).toBe(false);
    // Another trip's budget is unaffected by the first trip's spending.
    const otherTrip = await reserveVoiceCall(
      pool,
      reserveInput(secondTrip, { reservedCostUsd: "0.009", maxCostUsdPerTrip: "0.01" }),
    );
    expect(otherTrip.ok).toBe(true);
    // Explicit "no units yet" is a valid reservation (units arrive at settle).
    const noUnits = await reserveVoiceCall(
      pool,
      reserveInput(secondTrip, { unitKind: null, inputUnits: null, reservedCostUsd: "0.0001" }),
    );
    expect(noUnits.ok).toBe(true);
    // A kind without its units (or units without a kind) is a programming error.
    await expect(
      reserveVoiceCall(
        pool,
        reserveInput(secondTrip, { unitKind: "characters", inputUnits: null }),
      ),
    ).rejects.toThrow(/provided together/);
    await expect(
      reserveVoiceCall(pool, reserveInput(secondTrip, { unitKind: null, inputUnits: 42 })),
    ).rejects.toThrow(/provided together/);
  });
});
