import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendConversationMessage,
  loadPublicInspector,
  markVoiceCallUnknown,
  reserveVoiceCall,
  settleVoiceCallSuccess,
  sumTripLlmCostUsd,
} from "@odft/persistence";
import { createGraphTestPool, createHarnessTrip, resetGraphDatabase } from "../graph/_setup.js";

/**
 * T-IT-VOICE-08 (VOICE_CONTROLL.md section 15): the inspector exposes a safe,
 * separate Voice usage section, fixture mode produces zero billable rows, and
 * the existing LLM/travel accounting stays untouched.
 */

describe("inspector voice section", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createGraphTestPool(8);
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps a cancelled reservation visible with a null safe error code", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const reserved = await reserveVoiceCall(pool, {
      tripId,
      requestId: randomUUID(),
      requestFingerprint: "fingerprint-abort",
      kind: "stt",
      model: "openai/whisper-large-v3-turbo",
      providerRestriction: "groq",
      unitKind: "audio_seconds",
      inputUnits: 8,
      reservedCostUsd: "0.004",
      maxCallCostUsd: "0.02",
      maxCallsPerTrip: 60,
      maxCostUsdPerTrip: "1.00",
    });
    if (!reserved.ok) {
      throw new Error("expected the reservation to succeed");
    }
    await markVoiceCallUnknown(pool, reserved.callId, { errorCode: "VOICE_REQUEST_ABORTED" });
    const inspector = await loadPublicInspector(pool, tripId);
    expect(inspector.voiceCalls).toHaveLength(1);
    expect(inspector.voiceCalls[0]).toMatchObject({
      status: "unknown_reserved",
      errorCode: null,
      reservedCostUsd: "0.004",
    });
  });

  it("shows safe voice rows separately and leaves LLM and travel accounting untouched", async () => {
    const { tripId, creationOperationId } = await createHarnessTrip(pool);

    const before = await loadPublicInspector(pool, tripId);
    expect(before.voiceCalls).toEqual([]);
    expect(before.llmCalls).toEqual([]);

    const stt = await reserveVoiceCall(pool, {
      tripId,
      requestId: randomUUID(),
      requestFingerprint: "fingerprint-stt",
      kind: "stt",
      model: "openai/whisper-large-v3-turbo",
      providerRestriction: "groq",
      unitKind: "audio_seconds",
      inputUnits: 12,
      reservedCostUsd: "0.004",
      maxCallCostUsd: "0.02",
      maxCallsPerTrip: 60,
      maxCostUsdPerTrip: "1.00",
    });
    if (!stt.ok) {
      throw new Error("expected the stt reservation to succeed");
    }
    await markVoiceCallUnknown(pool, stt.callId, { errorCode: "VOICE_TIMEOUT" });

    const message = await appendConversationMessage(pool, {
      tripId,
      role: "assistant",
      content: "Plan ready for review.",
      operationId: creationOperationId,
      requestId: randomUUID(),
    });
    const tts = await reserveVoiceCall(pool, {
      tripId,
      requestId: randomUUID(),
      requestFingerprint: "fingerprint-tts",
      kind: "tts",
      model: "elevenlabs/eleven-v4-turbo",
      operationId: creationOperationId,
      messageId: message.id,
      unitKind: "characters",
      inputUnits: 21,
      reservedCostUsd: "0.05",
      maxCallCostUsd: "0.05",
      maxCallsPerTrip: 60,
      maxCostUsdPerTrip: "1.00",
    });
    if (!tts.ok) {
      throw new Error("expected the tts reservation to succeed");
    }
    await settleVoiceCallSuccess(pool, tts.callId, {
      costStatus: "estimated",
      costUsd: "0.00042",
      latencyMs: 810,
      inputUnits: 21,
      unitKind: "characters",
      servingProviderId: "elevenlabs",
      generationId: "gen-tts-1",
    });

    const inspector = await loadPublicInspector(pool, tripId);
    expect(inspector.voiceCalls).toHaveLength(2);
    const sttRow = inspector.voiceCalls.find((call) => call.kind === "stt");
    expect(sttRow).toMatchObject({
      restrictedProviderId: "groq",
      unitKind: "audio_seconds",
      inputUnits: 12,
      status: "unknown_reserved",
      costStatus: "unknown_reserved",
      reservedCostUsd: "0.004",
      actualCostUsd: null,
    });
    const ttsRow = inspector.voiceCalls.find((call) => call.kind === "tts");
    expect(ttsRow).toMatchObject({
      servingProviderId: "elevenlabs",
      unitKind: "characters",
      inputUnits: 21,
      status: "succeeded",
      costStatus: "estimated",
      actualCostUsd: "0.00042",
    });

    // Safety: no message content, fingerprints, keys, or generation ids — the
    // ledger stores the generation id for server-side reconciliation only.
    const serialized = JSON.stringify(inspector);
    expect(serialized).not.toContain("Plan ready for review.");
    expect(serialized).not.toContain("fingerprint-stt");
    expect(serialized).not.toContain("fingerprint-tts");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("gen-tts-1");
    expect(serialized).not.toContain("generationId");

    // The separate ledger never leaks into the LLM or travel accounting.
    expect(inspector.llmCalls).toEqual([]);
    expect(await sumTripLlmCostUsd(pool, tripId)).toBe(0n);
    const reservations = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.reservations WHERE trip_id = $1`,
      [tripId],
    );
    expect(reservations.rows[0]?.count).toBe("0");
  });
});
