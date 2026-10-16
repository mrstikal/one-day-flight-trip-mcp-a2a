import { describe, expect, it } from "vitest";
import {
  MAX_STT_RESPONSE_BYTES,
  OpenRouterSpeechAdapter,
  OPENROUTER_SPEECH_URL,
  OPENROUTER_TRANSCRIPTIONS_URL,
  SpeechError,
  type SpeechFetch,
} from "@odft/ai";

/**
 * T-UT-VOICE-06/07 (VOICE_CONTROLL.md section 15): exact OpenRouter URLs,
 * request fields, and key separation; raw audio is never parsed as JSON; and
 * empty/oversized/invalid responses, HTTP failures, timeouts, and aborts are
 * explicit typed errors. Exactly one transport attempt per request.
 */

const WHISPER = "openai/whisper-large-v3-turbo";
const ELEVEN = "elevenlabs/eleven-v4-turbo";

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function adapterWith(
  fetchImpl: SpeechFetch,
  overrides: Partial<ConstructorParameters<typeof OpenRouterSpeechAdapter>[0]> = {},
): OpenRouterSpeechAdapter {
  return new OpenRouterSpeechAdapter({
    sttApiKey: "sk-stt-dedicated",
    ttsApiKey: "sk-tts-shared",
    sttModel: WHISPER,
    ttsModel: ELEVEN,
    ttsVoice: "george",
    sttTimeoutMs: 2_000,
    ttsTimeoutMs: 2_000,
    maxResponseAudioBytes: 8_388_608,
    maxTranscriptCharacters: 2_000,
    fetchImpl,
    ...overrides,
  });
}

function jsonFetch(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(JSON.stringify(payload), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...init.headers },
    });
  }) as unknown as SpeechFetch;
  return { calls, fetchImpl };
}

const abortSignal = (): AbortSignal => new AbortController().signal;

describe("OpenRouterSpeechAdapter transport", () => {
  it("sends the exact documented STT request with the dedicated key", async () => {
    const { calls, fetchImpl } = jsonFetch({
      text: "  hello world  ",
      usage: { seconds: 2.5, cost: 0.000277778 },
    });
    const adapter = adapterWith(fetchImpl);
    const audio = new Uint8Array([1, 2, 3, 4]);
    const result = await adapter.transcribe({ audio, format: "wav", signal: abortSignal() });

    expect(result.text).toBe("hello world");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) {
      throw new Error("no call recorded");
    }
    expect(call.url).toBe(OPENROUTER_TRANSCRIPTIONS_URL);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-stt-dedicated");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: WHISPER,
      input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" },
      response_format: "json",
    });
    expect(result.usage).toEqual({
      latencyMs: expect.any(Number),
      costStatus: "actual",
      costUsd: "0.000277778",
      units: 2.5,
      unitKind: "audio_seconds",
    });
  });

  it("sends the exact documented TTS request with the shared key and reads raw bytes", async () => {
    const calls: RecordedCall[] = [];
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x10, 0x20]);
    const fetchImpl = (async (url: string | URL | Request, requestInit?: RequestInit) => {
      calls.push({ url: String(url), init: requestInit ?? {} });
      return new Response(audioBytes, {
        status: 200,
        headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-tts-1" },
      });
    }) as unknown as SpeechFetch;
    const adapter = adapterWith(fetchImpl);
    const result = await adapter.synthesize({
      text: "Your day is ready. 🙂",
      signal: abortSignal(),
    });

    expect(result.audio).toEqual(audioBytes);
    expect(result.contentType).toBe("audio/mpeg");
    const call = calls[0];
    if (!call) {
      throw new Error("no call recorded");
    }
    expect(call.url).toBe(OPENROUTER_SPEECH_URL);
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-tts-shared");
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: ELEVEN,
      input: "Your day is ready. 🙂",
      voice: "george",
      response_format: "mp3",
    });
    expect(result.usage.costStatus).toBe("estimated");
    expect(result.usage.units).toBe("Your day is ready. 🙂".length);
    expect(result.usage.generationId).toBe("gen-tts-1");
  });

  it("keeps the keys separate and refuses a shared or missing key", () => {
    expect(
      () =>
        new OpenRouterSpeechAdapter({
          sttApiKey: "sk-same",
          ttsApiKey: "sk-same",
          sttModel: WHISPER,
          ttsModel: ELEVEN,
          ttsVoice: "george",
          sttTimeoutMs: 1_000,
          ttsTimeoutMs: 1_000,
          maxResponseAudioBytes: 1_024,
          maxTranscriptCharacters: 2_000,
        }),
    ).toThrow(/must differ/);
    expect(
      () =>
        new OpenRouterSpeechAdapter({
          sttApiKey: "",
          ttsApiKey: "sk-tts",
          sttModel: WHISPER,
          ttsModel: ELEVEN,
          ttsVoice: "george",
          sttTimeoutMs: 1_000,
          ttsTimeoutMs: 1_000,
          maxResponseAudioBytes: 1_024,
          maxTranscriptCharacters: 2_000,
        }),
    ).toThrow(SpeechError);
  });
});

describe("OpenRouterSpeechAdapter failures", () => {
  it("maps authentication and credit failures to VOICE_NOT_CONFIGURED", async () => {
    for (const status of [401, 402, 403]) {
      const { fetchImpl } = jsonFetch({ error: { message: "nope" } }, { status });
      const adapter = adapterWith(fetchImpl);
      await expect(
        adapter.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: abortSignal() }),
      ).rejects.toMatchObject({ code: "VOICE_NOT_CONFIGURED", retryable: false });
    }
  });

  it("maps 429 and 5xx to a retryable upstream failure with exactly one attempt", async () => {
    for (const status of [429, 500, 503]) {
      const { calls, fetchImpl } = jsonFetch({ error: {} }, { status });
      const adapter = adapterWith(fetchImpl);
      await expect(
        adapter.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: abortSignal() }),
      ).rejects.toMatchObject({ code: "VOICE_UPSTREAM_FAILED", retryable: true });
      expect(calls).toHaveLength(1);
    }
  });

  it("maps other HTTP failures to a non-retryable upstream failure", async () => {
    const { fetchImpl } = jsonFetch({}, { status: 418 });
    const adapter = adapterWith(fetchImpl);
    await expect(
      adapter.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: abortSignal() }),
    ).rejects.toMatchObject({ code: "VOICE_UPSTREAM_FAILED", retryable: false });
  });

  it("classifies empty, over-long, invalid, and oversized STT responses", async () => {
    const empty = adapterWith(jsonFetch({ text: "   " }).fetchImpl);
    await expect(
      empty.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: abortSignal() }),
    ).rejects.toMatchObject({ code: "VOICE_NO_SPEECH" });

    const tooLong = adapterWith(jsonFetch({ text: "x".repeat(11) }).fetchImpl, {
      maxTranscriptCharacters: 10,
    });
    await expect(
      tooLong.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: abortSignal() }),
    ).rejects.toMatchObject({ code: "VOICE_TRANSCRIPT_TOO_LONG" });

    const invalidJson = adapterWith(
      (async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as SpeechFetch,
    );
    await expect(
      invalidJson.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: abortSignal() }),
    ).rejects.toMatchObject({ code: "VOICE_UPSTREAM_FAILED" });

    const oversize = adapterWith(
      (async () =>
        new Response(JSON.stringify({ text: "x".repeat(MAX_STT_RESPONSE_BYTES + 1) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as SpeechFetch,
    );
    await expect(
      oversize.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: abortSignal() }),
    ).rejects.toMatchObject({ code: "VOICE_UPSTREAM_FAILED" });
  });

  it("classifies wrong MIME, oversized, and empty TTS responses", async () => {
    const wrongMime = adapterWith(
      (async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as SpeechFetch,
    );
    await expect(wrongMime.synthesize({ text: "hi", signal: abortSignal() })).rejects.toMatchObject(
      {
        code: "VOICE_UPSTREAM_FAILED",
      },
    );

    const oversized = adapterWith(
      (async () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        })) as unknown as SpeechFetch,
      { maxResponseAudioBytes: 8 },
    );
    await expect(oversized.synthesize({ text: "hi", signal: abortSignal() })).rejects.toMatchObject(
      {
        code: "VOICE_UPSTREAM_FAILED",
      },
    );

    const emptyBody = adapterWith(
      (async () =>
        new Response(new Uint8Array(0), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        })) as unknown as SpeechFetch,
    );
    await expect(emptyBody.synthesize({ text: "hi", signal: abortSignal() })).rejects.toMatchObject(
      {
        code: "VOICE_UPSTREAM_FAILED",
      },
    );
  });

  it("enforces the deadline as VOICE_TIMEOUT and never leaves the fetch hanging", async () => {
    const hanging: SpeechFetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal ?? null;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as unknown as SpeechFetch;
    const adapter = adapterWith(hanging, { sttTimeoutMs: 20 });
    await expect(
      adapter.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: abortSignal() }),
    ).rejects.toMatchObject({ code: "VOICE_TIMEOUT", retryable: true });
  });

  it("classifies a caller cancellation as VOICE_REQUEST_ABORTED", async () => {
    const controller = new AbortController();
    controller.abort();
    const hanging: SpeechFetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal ?? null;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as unknown as SpeechFetch;
    const adapter = adapterWith(hanging);
    await expect(
      adapter.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "VOICE_REQUEST_ABORTED", retryable: false });
  });

  it("never sends extra routing or language fields", async () => {
    const { calls, fetchImpl } = jsonFetch({ text: "ok" });
    const adapter = adapterWith(fetchImpl);
    await adapter.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: abortSignal() });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["input_audio", "model", "response_format"]);
  });
});
