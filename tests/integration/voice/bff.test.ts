import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FIXTURE_TRANSCRIPT,
  normalizeSpeechCapability,
  OPENROUTER_SPEECH_URL,
  OPENROUTER_TRANSCRIPTIONS_URL,
  speechCapabilityManifestSchema,
  type SpeechFetch,
} from "@odft/ai";
import {
  admitOperation,
  createTrip,
  parseServerConfig,
  type ServerConfig,
} from "@odft/persistence";
import { issueSession } from "../../../apps/web/src/lib/session.js";
import {
  handleVoiceCapabilities,
  handleVoiceSynthesize,
  handleVoiceTranscribe,
} from "../../../apps/web/src/lib/voice-routes.js";
import { createVoiceService } from "../../../apps/web/src/lib/voice-service.js";
import { encodePcmWav, inspectCanonicalWav } from "../../../apps/web/src/lib/voice-audio.js";
import {
  createGraphTestPool,
  requireTestDatabaseUrl,
  resetGraphDatabase,
} from "../graph/_setup.js";
import { fixtureCreationInput } from "../../fixtures/trip.js";

/**
 * T-IT-VOICE-01/02/03 (VOICE_CONTROLL.md section 15): real PostgreSQL plus the
 * real route handlers — guards, strict validation, byte caps, status mapping,
 * private headers, zero provider calls on every rejected input, live ledger
 * settlement, and no business-state mutation from successful speech.
 */

const HMAC = "integration-test-session-hmac-key-0123456789";
const WHISPER = "openai/whisper-large-v3-turbo";
const ELEVEN = "elevenlabs/eleven-v4-turbo";
const PRICING_VERSION = "voice-test-pricing-v1";

function baseEnv(): Record<string, string> {
  return {
    DATABASE_URL: requireTestDatabaseUrl(),
    PUBLIC_BASE_URL: "http://localhost:3000",
    SESSION_HMAC_KEY: HMAC,
  };
}

function fixtureConfig(): ServerConfig {
  return parseServerConfig({
    ...baseEnv(),
    AI_MODE: "fixture",
    VOICE_ENABLED: "true",
  });
}

function disabledConfig(): ServerConfig {
  return parseServerConfig({ ...baseEnv(), AI_MODE: "fixture" });
}

function incompleteLiveConfig(): ServerConfig {
  return parseServerConfig({
    ...baseEnv(),
    AI_MODE: "openrouter",
    OPENROUTER_API_KEY: "sk-shared-test-key",
    VOICE_ENABLED: "true",
  });
}

function liveConfig(configPath: string): ServerConfig {
  return parseServerConfig({
    ...baseEnv(),
    AI_MODE: "openrouter",
    OPENROUTER_API_KEY: "sk-shared-test-key",
    VOICE_ENABLED: "true",
    VOICE_CONFIG_PATH: configPath,
    OPENROUTER_STT_API_KEY: "sk-stt-test-key",
  });
}

function whisperPayload(): unknown {
  return {
    data: {
      id: WHISPER,
      architecture: { modality: "audio->transcription" },
      endpoints: [
        {
          tag: "deepinfra/us",
          provider_name: "DeepInfra",
          pricing: { prompt: "0.00000333", completion: "0", discount: 0 },
        },
        {
          tag: "groq",
          provider_name: "Groq",
          pricing: { prompt: "0.0000111111111111", completion: "0", discount: 0 },
        },
      ],
    },
  };
}

function elevenPayload(): unknown {
  return {
    data: {
      id: ELEVEN,
      architecture: { modality: "text->speech" },
      endpoints: [
        {
          tag: "elevenlabs",
          provider_name: "ElevenLabs",
          pricing: { prompt: "0.00002", completion: "0", discount: 0.5 },
        },
      ],
    },
  };
}

function writeLiveProfileFiles(dir: string): string {
  const profilesPath = join(dir, "voice-profiles.json");
  writeFileSync(
    profilesPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        pricingVersion: PRICING_VERSION,
        stt: {
          provider: "openrouter",
          model: WHISPER,
          endpointProviderId: "groq",
          timeoutMs: 20000,
          maxCallCostUsd: "0.02",
        },
        tts: {
          provider: "openrouter",
          model: ELEVEN,
          voice: "george",
          responseFormat: "mp3",
          timeoutMs: 20000,
          maxCallCostUsd: "0.05",
        },
        limits: {
          maxRecordingSeconds: 45,
          maxRequestAudioBytes: 2_097_152,
          maxResponseAudioBytes: 8_388_608,
          maxTranscriptCharacters: 2000,
          maxReplyCharacters: 2000,
          maxCallsPerTrip: 60,
          maxCostUsdPerTrip: "1.00",
        },
      },
      null,
      2,
    ),
  );
  const stt = normalizeSpeechCapability({
    kind: "stt",
    model: WHISPER,
    endpointProviderId: "groq",
    payload: whisperPayload(),
  });
  const tts = normalizeSpeechCapability({ kind: "tts", model: ELEVEN, payload: elevenPayload() });
  if (!stt || !tts) {
    throw new Error("fixture catalog must normalize");
  }
  const manifest = speechCapabilityManifestSchema.parse({
    fetchedAt: new Date().toISOString(),
    pricingVersion: PRICING_VERSION,
    stt,
    tts,
  });
  writeFileSync(`${profilesPath}.capabilities.json`, JSON.stringify(manifest, null, 2));
  return profilesPath;
}

interface FetchSpy {
  (url: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly calls: { catalog: number; stt: number; tts: number };
  readonly sttBodies: unknown[];
  readonly ttsBodies: unknown[];
}

function fakeFetch(options: { sttPayload?: unknown; ttsBytes?: Uint8Array } = {}): FetchSpy {
  const calls = { catalog: 0, stt: 0, tts: 0 };
  const sttBodies: unknown[] = [];
  const ttsBodies: unknown[] = [];
  const spy = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith(`/${WHISPER}/endpoints`)) {
      calls.catalog += 1;
      return new Response(JSON.stringify(whisperPayload()), { status: 200 });
    }
    if (target.endsWith(`/${ELEVEN}/endpoints`)) {
      calls.catalog += 1;
      return new Response(JSON.stringify(elevenPayload()), { status: 200 });
    }
    if (target === OPENROUTER_TRANSCRIPTIONS_URL) {
      calls.stt += 1;
      sttBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify(
          options.sttPayload ?? {
            text: "Confirmed flight options",
            usage: { seconds: 2.1, cost: 0.000023 },
          },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target === OPENROUTER_SPEECH_URL) {
      calls.tts += 1;
      ttsBodies.push(JSON.parse(String(init?.body)));
      // `slice()` yields an ArrayBuffer-backed view accepted by DOM BodyInit.
      const audioBytes = options.ttsBytes ?? new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      return new Response(audioBytes.slice(), {
        status: 200,
        // A distinctive upstream header the route must NOT forward.
        headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-upstream-1" },
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as FetchSpy;
  return Object.assign(spy, { calls, sttBodies, ttsBodies });
}

function wav(samples = 16_000): Uint8Array {
  const data = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    data[index] = Math.sin(index / 20) * 0.3;
  }
  return encodePcmWav(data);
}

function paramsFor(tripId: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: tripId }) };
}

/** Response JSON as a record (undici types return `unknown`). */
async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * A trip plus the owner's auth headers, created with an issued session so the
 * route guards resolve a real signed cookie.
 */
async function createOwnedTrip(
  pool: Pool,
  config: ServerConfig,
): Promise<{
  tripId: string;
  sessionId: string;
  creationOperationId: string;
  headers: Record<string, string>;
}> {
  const session = await issueSession(pool, config);
  const created = await createTrip(pool, {
    sessionId: session.sessionId,
    input: fixtureCreationInput(),
  });
  if (!("tripId" in created)) {
    throw new Error(`fixture createTrip failed: ${created.code}`);
  }
  return {
    tripId: created.tripId,
    sessionId: session.sessionId,
    creationOperationId: created.operationId,
    headers: {
      origin: config.publicBaseUrl,
      cookie: (session.setCookie ?? "").split(";")[0] ?? "",
      "x-csrf-token": session.csrfToken,
    },
  };
}

function transcribeRequest(
  tripId: string,
  headers: Record<string, string>,
  audio: Uint8Array,
  extra: Record<string, string> = {},
): Request {
  return new Request(`http://localhost:3000/api/trips/${tripId}/voice/transcribe`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "audio/wav",
      "x-voice-request-id": randomUUID(),
      ...extra,
    },
    // `slice()` yields an ArrayBuffer-backed view accepted by BodyInit.
    body: audio.slice(),
  });
}

function synthesizeRequest(
  tripId: string,
  headers: Record<string, string>,
  payload: unknown,
): Request {
  return new Request(`http://localhost:3000/api/trips/${tripId}/voice/synthesize`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("voice BFF routes", () => {
  let pool: Pool;
  let tempDir: string;

  beforeAll(async () => {
    pool = createGraphTestPool(4);
    tempDir = mkdtempSync(join(tmpdir(), "voice-bff-"));
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    rmSync(tempDir, { recursive: true, force: true });
    await pool.end();
  });

  function fixtureService(config: ServerConfig) {
    return createVoiceService({ pool, config });
  }

  describe("fixture mode", () => {
    it("returns safe capabilities with private headers", async () => {
      const config = fixtureConfig();
      const { tripId, headers } = await createOwnedTrip(pool, config);
      const response = await handleVoiceCapabilities(
        new Request(`http://localhost:3000/api/trips/${tripId}/voice/capabilities`, { headers }),
        paramsFor(tripId),
        { pool, config, service: fixtureService(config) },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(await jsonRecord(response)).toEqual({
        enabled: true,
        mode: "fixture",
        maxRecordingSeconds: 60,
        maxRequestAudioBytes: 2_097_152,
        maxTranscriptCharacters: 2000,
        inputMimeType: "audio/wav",
      });
    });

    it("keeps disabled mode honest and invalid live configuration explicit", async () => {
      const { tripId, headers: disabledHeaders } = await createOwnedTrip(pool, disabledConfig());

      const disabled = disabledConfig();
      const capabilities = await handleVoiceCapabilities(
        new Request(`http://localhost:3000/api/trips/${tripId}/voice/capabilities`, {
          headers: disabledHeaders,
        }),
        paramsFor(tripId),
        { pool, config: disabled, service: fixtureService(disabled) },
      );
      expect(capabilities.status).toBe(200);
      expect((await jsonRecord(capabilities)).enabled).toBe(false);
      const transcribeDisabled = await handleVoiceTranscribe(
        transcribeRequest(tripId, disabledHeaders, wav(100)),
        paramsFor(tripId),
        { pool, config: disabled, service: fixtureService(disabled) },
      );
      expect(transcribeDisabled.status).toBe(403);
      expect((await jsonRecord(transcribeDisabled)).code).toBe("VOICE_DISABLED");
      const synthesizeDisabled = await handleVoiceSynthesize(
        synthesizeRequest(tripId, disabledHeaders, {
          requestId: randomUUID(),
          messageId: randomUUID(),
        }),
        paramsFor(tripId),
        { pool, config: disabled, service: fixtureService(disabled) },
      );
      expect(synthesizeDisabled.status).toBe(403);
      expect((await jsonRecord(synthesizeDisabled)).code).toBe("VOICE_DISABLED");

      // Enabled but unconfigured live mode is an explicit 503, never a silent
      // enabled:false fallback.
      const incomplete = incompleteLiveConfig();
      const incompleteTrip = await createOwnedTrip(pool, incomplete);
      const broken = await handleVoiceCapabilities(
        new Request(`http://localhost:3000/api/trips/${incompleteTrip.tripId}/voice/capabilities`, {
          headers: incompleteTrip.headers,
        }),
        paramsFor(incompleteTrip.tripId),
        { pool, config: incomplete, service: fixtureService(incomplete) },
      );
      expect(broken.status).toBe(503);
      expect((await jsonRecord(broken)).code).toBe("VOICE_NOT_CONFIGURED");

      // A dedicated STT key equal to the shared key is invalid configuration.
      const shared = parseServerConfig({
        ...baseEnv(),
        AI_MODE: "openrouter",
        OPENROUTER_API_KEY: "sk-same-key",
        VOICE_ENABLED: "true",
        VOICE_CONFIG_PATH: "voice-profiles.json",
        OPENROUTER_STT_API_KEY: "sk-same-key",
      });
      const sharedTrip = await createOwnedTrip(pool, shared);
      const sameKey = await handleVoiceCapabilities(
        new Request(`http://localhost:3000/api/trips/${sharedTrip.tripId}/voice/capabilities`, {
          headers: sharedTrip.headers,
        }),
        paramsFor(sharedTrip.tripId),
        { pool, config: shared, service: fixtureService(shared) },
      );
      expect(sameKey.status).toBe(503);
      expect((await jsonRecord(sameKey)).code).toBe("VOICE_NOT_CONFIGURED");
    });

    it("rejects missing session, bad origin, bad CSRF, and foreign trips", async () => {
      const config = fixtureConfig();
      const service = fixtureService(config);
      const { tripId, headers: good } = await createOwnedTrip(pool, config);

      const missingSession = await handleVoiceCapabilities(
        new Request(`http://localhost:3000/api/trips/${tripId}/voice/capabilities`, {
          headers: { origin: config.publicBaseUrl },
        }),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(missingSession.status).toBe(401);

      const expiredSession = await issueSession(pool, config);
      await pool.query(
        `UPDATE odft_app.anonymous_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [expiredSession.sessionId],
      );
      const expired = await handleVoiceTranscribe(
        transcribeRequest(
          tripId,
          {
            origin: config.publicBaseUrl,
            cookie: (expiredSession.setCookie ?? "").split(";")[0] ?? "",
            "x-csrf-token": expiredSession.csrfToken,
          },
          wav(100),
        ),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(expired.status).toBe(401);

      const badOrigin = await handleVoiceTranscribe(
        transcribeRequest(tripId, { ...good, origin: "http://evil.example" }, wav(100)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(badOrigin.status).toBe(403);

      const badCsrf = await handleVoiceTranscribe(
        transcribeRequest(tripId, { ...good, "x-csrf-token": "wrong" }, wav(100)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(badCsrf.status).toBe(403);

      const foreign = (await createOwnedTrip(pool, config)).headers;
      for (const tripTarget of [tripId, "not-a-uuid", randomUUID()]) {
        const response = await handleVoiceCapabilities(
          new Request(`http://localhost:3000/api/trips/${tripTarget}/voice/capabilities`, {
            headers: foreign,
          }),
          paramsFor(tripTarget),
          { pool, config, service },
        );
        expect(response.status).toBe(404);
      }
    });

    it("transcribes one fixture recording and mutates no business state", async () => {
      const config = fixtureConfig();
      const service = fixtureService(config);
      const { tripId, sessionId, creationOperationId, headers } = await createOwnedTrip(
        pool,
        config,
      );
      const request = transcribeRequest(tripId, headers, wav(16_000));
      const requestId = request.headers.get("x-voice-request-id") ?? "";

      const before = await pool.query<{ revision: number }>(
        `SELECT revision FROM odft_app.trips WHERE id = $1`,
        [tripId],
      );
      const beforeCountsQuery = await pool.query<{ operations: string; messages: string }>(
        `SELECT (SELECT count(*)::text FROM odft_app.workflow_operations WHERE trip_id = $1) AS operations,
                (SELECT count(*)::text FROM odft_app.conversation_messages WHERE trip_id = $1) AS messages`,
        [tripId],
      );
      const beforeCounts = {
        operations: beforeCountsQuery.rows[0]?.operations ?? "",
        messages: beforeCountsQuery.rows[0]?.messages ?? "",
      };
      const response = await handleVoiceTranscribe(request, paramsFor(tripId), {
        pool,
        config,
        service,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await jsonRecord(response)).toEqual({
        requestId,
        text: FIXTURE_TRANSCRIPT,
        mode: "fixture",
      });

      const after = await pool.query<{ revision: number }>(
        `SELECT revision FROM odft_app.trips WHERE id = $1`,
        [tripId],
      );
      expect(after.rows[0]?.revision).toBe(before.rows[0]?.revision);
      const counts = await pool.query<{
        operations: string;
        messages: string;
        reservations: string;
        voice: string;
      }>(
        `SELECT (SELECT count(*)::text FROM odft_app.workflow_operations WHERE trip_id = $1) AS operations,
                (SELECT count(*)::text FROM odft_app.conversation_messages WHERE trip_id = $1) AS messages,
                (SELECT count(*)::text FROM odft_app.reservations WHERE trip_id = $1) AS reservations,
                (SELECT count(*)::text FROM odft_app.voice_calls WHERE trip_id = $1) AS voice`,
        [tripId],
      );
      // Fixture speech never bills and never touches reservations.
      expect(counts.rows[0]).toEqual({
        operations: beforeCounts.operations,
        messages: beforeCounts.messages,
        reservations: "0",
        voice: "0",
      });

      // An explicit Send still uses the existing admission exactly once; the
      // creation operation is settled first so admission is not fenced.
      await pool.query(
        `UPDATE odft_app.workflow_operations SET status = 'succeeded' WHERE id = $1`,
        [creationOperationId],
      );
      const revision = after.rows[0]?.revision as number;
      const chat = {
        requestId: randomUUID(),
        expectedRevision: revision,
        chat: "Plan something else",
      };
      const admitted = await admitOperation(pool, {
        tripId,
        sessionId,
        request: chat,
        userMessage: chat.chat,
      });
      expect("operationId" in admitted).toBe(true);
      const duplicate = await admitOperation(pool, {
        tripId,
        sessionId,
        request: chat,
        userMessage: chat.chat,
      });
      // A duplicate request id reuses the same operation — never a second one.
      expect("operationId" in duplicate && duplicate.operationId === admitted.operationId).toBe(
        true,
      );
      const messages = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM odft_app.conversation_messages WHERE trip_id = $1`,
        [tripId],
      );
      expect(messages.rows[0]?.count).toBe(String(Number(beforeCounts.messages) + 1));
    });

    it("rejects unsupported audio, invalid headers, and oversized bodies", async () => {
      const config = fixtureConfig();
      const service = fixtureService(config);
      const { tripId, headers } = await createOwnedTrip(pool, config);

      const wrongType = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, wav(100), { "content-type": "audio/mpeg" }),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(wrongType.status).toBe(415);
      expect((await jsonRecord(wrongType)).code).toBe("VOICE_UNSUPPORTED_AUDIO");

      const noId = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, wav(100), { "x-voice-request-id": "nope" }),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(noId.status).toBe(400);

      const garbage = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, new Uint8Array([1, 2, 3, 4])),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(garbage.status).toBe(415);

      const oversized = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, new Uint8Array(2_097_153)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(oversized.status).toBe(413);
      expect((await jsonRecord(oversized)).code).toBe("VOICE_INPUT_TOO_LARGE");

      // Strict synthesis validation: no client text/voice/model fields.
      const extraField = await handleVoiceSynthesize(
        synthesizeRequest(tripId, headers, {
          requestId: randomUUID(),
          messageId: randomUUID(),
          text: "read this",
        }),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(extraField.status).toBe(400);
    });

    it("rate limits transcription to ten requests per session and minute", async () => {
      const config = fixtureConfig();
      const service = fixtureService(config);
      const { tripId, headers } = await createOwnedTrip(pool, config);
      let lastStatus = 0;
      for (let index = 0; index < 11; index += 1) {
        const response = await handleVoiceTranscribe(
          transcribeRequest(tripId, headers, wav(160)),
          paramsFor(tripId),
          { pool, config, service },
        );
        lastStatus = response.status;
      }
      expect(lastStatus).toBe(429);
    });
  });

  describe("live mode", () => {
    it("serves profile limits, transcribes with authoritative usage, and never calls a provider for invalid input", async () => {
      const profilesPath = writeLiveProfileFiles(tempDir);
      const config = liveConfig(profilesPath);
      const fetchImpl = fakeFetch();
      const service = createVoiceService({ pool, config, fetchImpl: fetchImpl as SpeechFetch });
      const { tripId, headers } = await createOwnedTrip(pool, config);

      const capabilities = await handleVoiceCapabilities(
        new Request(`http://localhost:3000/api/trips/${tripId}/voice/capabilities`, { headers }),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(await jsonRecord(capabilities)).toEqual({
        enabled: true,
        mode: "openrouter",
        maxRecordingSeconds: 45,
        maxRequestAudioBytes: 2_097_152,
        maxTranscriptCharacters: 2000,
        inputMimeType: "audio/wav",
      });
      // Capabilities never touch the provider.
      expect(fetchImpl.calls).toEqual({ catalog: 0, stt: 0, tts: 0 });

      const audio = wav(32_000);
      const request = transcribeRequest(tripId, headers, audio);
      const requestId = request.headers.get("x-voice-request-id") ?? "";
      const response = await handleVoiceTranscribe(request, paramsFor(tripId), {
        pool,
        config,
        service,
      });
      expect(response.status).toBe(200);
      expect(await jsonRecord(response)).toEqual({
        requestId,
        text: "Confirmed flight options",
        mode: "openrouter",
      });
      expect(fetchImpl.calls.stt).toBe(1);
      // The per-call tariff recheck ran against the public catalog.
      expect(fetchImpl.calls.catalog).toBeGreaterThanOrEqual(2);
      expect(fetchImpl.sttBodies[0]).toEqual({
        model: WHISPER,
        input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" },
        response_format: "json",
      });
      const ledger = await pool.query<{
        status: string;
        cost_status: string;
        reserved: string;
        actual: string;
        unit_kind: string;
        input_units: string;
      }>(
        `SELECT status, cost_status, reserved_cost_usd::text AS reserved,
                actual_cost_usd::text AS actual, unit_kind, input_units::text AS input_units
           FROM odft_app.voice_calls WHERE trip_id = $1`,
        [tripId],
      );
      // 2 recorded seconds bill as the documented 10-second minimum.
      expect(ledger.rows[0]).toMatchObject({
        status: "succeeded",
        cost_status: "actual",
        unit_kind: "audio_seconds",
      });
      expect(Number(ledger.rows[0]?.actual)).toBeCloseTo(0.000023, 9);
      expect(ledger.rows[0]?.reserved).toContain("0.000111112");

      // A duplicate request id never calls the provider again.
      const duplicate = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, audio, { "x-voice-request-id": requestId }),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(duplicate.status).toBe(409);
      expect((await jsonRecord(duplicate)).code).toBe("VOICE_RESULT_EXPIRED");
      expect(fetchImpl.calls.stt).toBe(1);

      // Every rejected input performs zero provider calls.
      const rejected = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, new Uint8Array([9, 9, 9])),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(rejected.status).toBe(415);
      expect(fetchImpl.calls.stt).toBe(1);
    });

    it("enforces the budget before transport and retains no hidden zero for empty speech", async () => {
      const budgetDir = mkdtempSync(join(tempDir, "budget-"));
      const profilesPath = writeLiveProfileFiles(budgetDir);
      const raw = JSON.parse(readFileSync(profilesPath, "utf8")) as {
        limits: { maxCallsPerTrip: number };
      };
      raw.limits.maxCallsPerTrip = 1;
      writeFileSync(profilesPath, JSON.stringify(raw, null, 2));
      const config = liveConfig(profilesPath);
      const fetchImpl = fakeFetch();
      const service = createVoiceService({ pool, config, fetchImpl: fetchImpl as SpeechFetch });
      const { tripId, headers } = await createOwnedTrip(pool, config);

      const first = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, wav(16_000)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(first.status).toBe(200);

      const exhausted = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, wav(16_000)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(exhausted.status).toBe(409);
      expect((await jsonRecord(exhausted)).code).toBe("VOICE_BUDGET_EXCEEDED");
      expect(fetchImpl.calls.stt).toBe(1);
    });

    it("retains an uncertain reservation when the provider returns no speech", async () => {
      const emptyDir = mkdtempSync(join(tempDir, "empty-"));
      const profilesPath = writeLiveProfileFiles(emptyDir);
      const config = liveConfig(profilesPath);
      const fetchImpl = fakeFetch({ sttPayload: { text: "   ", usage: { seconds: 3 } } });
      const service = createVoiceService({ pool, config, fetchImpl: fetchImpl as SpeechFetch });
      const { tripId, headers } = await createOwnedTrip(pool, config);

      const response = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, wav(16_000)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(response.status).toBe(422);
      expect((await jsonRecord(response)).code).toBe("VOICE_NO_SPEECH");
      const ledger = await pool.query<{
        status: string;
        cost_status: string | null;
        actual: string | null;
      }>(
        `SELECT status, cost_status, actual_cost_usd::text AS actual FROM odft_app.voice_calls WHERE trip_id = $1`,
        [tripId],
      );
      expect(ledger.rows[0]).toEqual({
        status: "unknown_reserved",
        cost_status: "unknown_reserved",
        actual: null,
      });
    });

    it("rejects over-duration recordings and guard failures before any provider call", async () => {
      const limitDir = mkdtempSync(join(tempDir, "duration-"));
      const profilesPath = writeLiveProfileFiles(limitDir);
      const config = liveConfig(profilesPath);
      const fetchImpl = fakeFetch();
      const service = createVoiceService({ pool, config, fetchImpl: fetchImpl as SpeechFetch });
      const { tripId, headers } = await createOwnedTrip(pool, config);

      // 46 s of audio exceeds the profile's 45 s limit while staying under the
      // hard 60 s canonical cap: it must refuse before any reservation/transport.
      const tooLong = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, wav(46 * 16_000)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(tooLong.status).toBe(413);
      expect((await jsonRecord(tooLong)).code).toBe("VOICE_INPUT_TOO_LARGE");
      expect(fetchImpl.calls).toEqual({ catalog: 0, stt: 0, tts: 0 });
      const rows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM odft_app.voice_calls WHERE trip_id = $1`,
        [tripId],
      );
      expect(rows.rows[0]?.count).toBe("0");

      // Guard and ownership failures in live mode perform zero provider AND
      // zero catalog calls.
      const badCsrf = await handleVoiceTranscribe(
        transcribeRequest(tripId, { ...headers, "x-csrf-token": "wrong" }, wav(16_000)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(badCsrf.status).toBe(403);
      const foreign = await handleVoiceSynthesize(
        synthesizeRequest(tripId, (await createOwnedTrip(pool, config)).headers, {
          requestId: randomUUID(),
          messageId: randomUUID(),
        }),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(foreign.status).toBe(404);
      expect(fetchImpl.calls).toEqual({ catalog: 0, stt: 0, tts: 0 });
    });

    it("refuses live transport once the pinned manifest is older than 24 hours", async () => {
      const freshnessDir = mkdtempSync(join(tempDir, "freshness-"));
      const profilesPath = writeLiveProfileFiles(freshnessDir);
      const config = liveConfig(profilesPath);
      const fetchImpl = fakeFetch();
      const start = Date.now();
      let clock = start;
      const service = createVoiceService({
        pool,
        config,
        fetchImpl: fetchImpl as SpeechFetch,
        now: () => new Date(clock),
      });
      const { tripId, headers } = await createOwnedTrip(pool, config);

      const first = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, wav(16_000)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(first.status).toBe(200);
      expect(fetchImpl.calls.stt).toBe(1);

      // 25 h later the runtime cache is still warm, but EVERY live call must
      // re-check the pinned manifest age and refuse transport.
      clock = start + 25 * 60 * 60 * 1000;
      const second = await handleVoiceTranscribe(
        transcribeRequest(tripId, headers, wav(16_000)),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(second.status).toBe(503);
      expect((await jsonRecord(second)).code).toBe("VOICE_CAPABILITY_UNKNOWN");
      expect(fetchImpl.calls.stt).toBe(1);
      const ledger = await pool.query<{ status: string }>(
        `SELECT status FROM odft_app.voice_calls WHERE trip_id = $1 ORDER BY created_at ASC`,
        [tripId],
      );
      expect(ledger.rows.map((row) => row.status)).toEqual(["succeeded", "failed"]);
    });

    it("synthesizes only the authoritative message content and never accepts other fields", async () => {
      const synthDir = mkdtempSync(join(tempDir, "synth-"));
      const profilesPath = writeLiveProfileFiles(synthDir);
      const config = liveConfig(profilesPath);
      const fetchImpl = fakeFetch();
      const service = createVoiceService({ pool, config, fetchImpl: fetchImpl as SpeechFetch });
      const { tripId, creationOperationId, headers } = await createOwnedTrip(pool, config);

      await pool.query(
        `UPDATE odft_app.workflow_operations SET status = 'succeeded' WHERE id = $1`,
        [creationOperationId],
      );
      const content = "Your updated day is ready for review.";
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO odft_app.conversation_messages
           (id, trip_id, sequence, role, content, interpretation, result, operation_id, request_id)
         VALUES ($1, $2, 2, 'assistant', $3, $4::jsonb, NULL, $5, $6)
         RETURNING id`,
        [
          randomUUID(),
          tripId,
          content,
          JSON.stringify({ note: "INTERPRETATION_MUST_NOT_BE_SPOKEN" }),
          creationOperationId,
          randomUUID(),
        ],
      );
      const messageId = inserted.rows[0]?.id as string;

      const response = await handleVoiceSynthesize(
        synthesizeRequest(tripId, headers, { requestId: randomUUID(), messageId }),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/mpeg");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(response.headers.get("x-generation-id")).toBeNull();
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(0);
      expect(fetchImpl.calls.tts).toBe(1);
      expect(fetchImpl.ttsBodies[0]).toEqual({
        model: ELEVEN,
        input: content,
        voice: "george",
        response_format: "mp3",
      });
      const serialized = JSON.stringify(fetchImpl.ttsBodies[0]);
      expect(serialized).not.toContain("INTERPRETATION_MUST_NOT_BE_SPOKEN");
      const ledger = await pool.query<{ status: string; cost_status: string; input_units: string }>(
        `SELECT status, cost_status, input_units::text AS input_units FROM odft_app.voice_calls WHERE trip_id = $1`,
        [tripId],
      );
      expect(ledger.rows[0]).toMatchObject({ status: "succeeded", cost_status: "estimated" });
      expect(Number(ledger.rows[0]?.input_units)).toBe(content.length);

      // Early / unlinked / wrong-role messages never reach the provider.
      const queuedTrip = await createOwnedTrip(pool, config);
      const queuedHeaders = queuedTrip.headers;
      const queuedMessage = await pool.query<{ id: string }>(
        `INSERT INTO odft_app.conversation_messages
           (id, trip_id, sequence, role, content, operation_id, request_id)
         VALUES ($1, $2, 1, 'user', 'hello', $3, $4)
         RETURNING id`,
        [randomUUID(), queuedTrip.tripId, queuedTrip.creationOperationId, randomUUID()],
      );
      const userRole = await handleVoiceSynthesize(
        synthesizeRequest(queuedTrip.tripId, queuedHeaders, {
          requestId: randomUUID(),
          messageId: queuedMessage.rows[0]?.id as string,
        }),
        paramsFor(queuedTrip.tripId),
        { pool, config, service },
      );
      expect(userRole.status).toBe(409);

      const assistantQueued = await pool.query<{ id: string }>(
        `INSERT INTO odft_app.conversation_messages
           (id, trip_id, sequence, role, content, operation_id, request_id)
         VALUES ($1, $2, 2, 'assistant', 'still queued', $3, $4)
         RETURNING id`,
        [randomUUID(), queuedTrip.tripId, queuedTrip.creationOperationId, randomUUID()],
      );
      const running = await handleVoiceSynthesize(
        synthesizeRequest(queuedTrip.tripId, queuedHeaders, {
          requestId: randomUUID(),
          messageId: assistantQueued.rows[0]?.id as string,
        }),
        paramsFor(queuedTrip.tripId),
        { pool, config, service },
      );
      expect(running.status).toBe(409);
      expect((await jsonRecord(running)).code).toBe("VOICE_MESSAGE_NOT_READY");

      const unlinked = await pool.query<{ id: string }>(
        `INSERT INTO odft_app.conversation_messages
           (id, trip_id, sequence, role, content, request_id)
         VALUES ($1, $2, 3, 'assistant', 'no operation', $3)
         RETURNING id`,
        [randomUUID(), queuedTrip.tripId, randomUUID()],
      );
      const unlinkedResponse = await handleVoiceSynthesize(
        synthesizeRequest(queuedTrip.tripId, queuedHeaders, {
          requestId: randomUUID(),
          messageId: unlinked.rows[0]?.id as string,
        }),
        paramsFor(queuedTrip.tripId),
        { pool, config, service },
      );
      expect(unlinkedResponse.status).toBe(409);

      // A wrong-trip message id is a uniform 404 — a missing and an existing
      // foreign id are indistinguishable.
      const otherTrip = await createOwnedTrip(pool, config);
      const foreignMessage = await pool.query<{ id: string }>(
        `INSERT INTO odft_app.conversation_messages
           (id, trip_id, sequence, role, content, operation_id, request_id)
         VALUES ($1, $2, 1, 'assistant', 'foreign reply', $3, $4)
         RETURNING id`,
        [randomUUID(), otherTrip.tripId, otherTrip.creationOperationId, randomUUID()],
      );
      for (const candidate of [randomUUID(), foreignMessage.rows[0]?.id as string]) {
        const wrongTrip = await handleVoiceSynthesize(
          synthesizeRequest(tripId, headers, { requestId: randomUUID(), messageId: candidate }),
          paramsFor(tripId),
          { pool, config, service },
        );
        expect(wrongTrip.status).toBe(404);
      }
      expect(fetchImpl.calls.tts).toBe(1);
    });

    it("returns valid WAV fixture bytes without writing live rows in fixture synthesis", async () => {
      const config = fixtureConfig();
      const service = fixtureService(config);
      const { tripId, creationOperationId, headers } = await createOwnedTrip(pool, config);
      await pool.query(
        `UPDATE odft_app.workflow_operations SET status = 'succeeded' WHERE id = $1`,
        [creationOperationId],
      );
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO odft_app.conversation_messages
           (id, trip_id, sequence, role, content, operation_id, request_id)
         VALUES ($1, $2, 2, 'assistant', 'Fixture reply text', $3, $4)
         RETURNING id`,
        [randomUUID(), tripId, creationOperationId, randomUUID()],
      );
      const response = await handleVoiceSynthesize(
        synthesizeRequest(tripId, headers, {
          requestId: randomUUID(),
          messageId: inserted.rows[0]?.id as string,
        }),
        paramsFor(tripId),
        { pool, config, service },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const inspection = inspectCanonicalWav(bytes);
      expect(inspection.ok).toBe(true);
      const voiceRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM odft_app.voice_calls WHERE trip_id = $1`,
        [tripId],
      );
      expect(voiceRows.rows[0]?.count).toBe("0");
    });
  });
});
