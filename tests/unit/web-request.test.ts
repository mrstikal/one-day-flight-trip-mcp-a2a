import { describe, expect, it } from "vitest";
import {
  clientIp,
  MAX_JSON_BODY_BYTES,
  MAX_VOICE_AUDIO_BODY_BYTES,
  readBytesResult,
  readJsonResult,
} from "../../apps/web/src/lib/request.js";

/** Web request helpers: spoof-resistant client IP and bounded body parsing. */

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/", { method: "POST", headers, body });
}

/** A chunked (no Content-Length) stream body that reports cancellation.
 *
 * The body/headers are stubbed rather than wrapped in a real `Request`: undici's
 * Request re-wraps a stream body and does not propagate `reader.cancel()` back
 * to the source. The source also stays OPEN after the queued chunks so the
 * overflow cancellation is observable (cancelling an already-closed stream is a
 * no-op by spec).
 */
function streamRequest(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): { request: Request; cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      // Intentionally left open: the reader must cancel an overflow.
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    request: { headers: new Headers(headers), body: stream } as unknown as Request,
    cancelled: () => cancelled,
  };
}

describe("clientIp", () => {
  it("ignores client-supplied forwarded headers when the proxy is untrusted", () => {
    const request = post("{}", { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" });
    expect(clientIp(request, false)).toBe("direct");
  });

  it("uses the trusted proxy's nearest client address when enabled", () => {
    expect(clientIp(post("{}", { "x-forwarded-for": "1.2.3.4, 9.9.9.9" }), true)).toBe("9.9.9.9");
    expect(clientIp(post("{}", { "x-real-ip": "8.8.8.8" }), true)).toBe("8.8.8.8");
  });
});

describe("readJsonResult", () => {
  it("parses a small JSON body", async () => {
    expect(await readJsonResult(post('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects an oversized body with a hard byte cap", async () => {
    const oversized = JSON.stringify({ data: "x".repeat(MAX_JSON_BODY_BYTES + 10) });
    expect(await readJsonResult(post(oversized))).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects invalid JSON", async () => {
    expect(await readJsonResult(post("not json"))).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("readBytesResult (voice audio cap)", () => {
  it("keeps the JSON cap at 64 KiB and the binary cap at 2 MiB", async () => {
    expect(MAX_JSON_BODY_BYTES).toBe(64 * 1024);
    expect(MAX_VOICE_AUDIO_BODY_BYTES).toBe(2 * 1024 * 1024);
    // A body between the JSON cap and the audio cap stays invalid JSON but is
    // read fine as bytes: command bodies never grow to the audio limit.
    const middle = post("x".repeat(MAX_JSON_BODY_BYTES + 10));
    expect(await readJsonResult(middle)).toEqual({ ok: false, reason: "too_large" });
    const bytes = post("x".repeat(MAX_JSON_BODY_BYTES + 10));
    expect((await readBytesResult(bytes)).ok).toBe(true);
  });

  it("reads a bounded binary body and rejects a declared oversize length", async () => {
    const small = new Uint8Array([1, 2, 3, 4]);
    const ok = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-length": String(small.byteLength) },
      body: small,
    });
    expect(await readBytesResult(ok)).toEqual({ ok: true, bytes: small });

    const declaredTooLarge = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-length": String(MAX_VOICE_AUDIO_BODY_BYTES + 1) },
      body: small,
    });
    expect(await readBytesResult(declaredTooLarge)).toEqual({ ok: false, reason: "too_large" });
  });

  it("enforces the cap on a chunked body with no Content-Length and cancels it", async () => {
    const chunk = new Uint8Array(512 * 1024);
    const { request, cancelled } = streamRequest([chunk, chunk, chunk, chunk, chunk]);
    const result = await readBytesResult(request);
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(cancelled()).toBe(true);
  });

  it("does not trust a false small Content-Length on a larger stream", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const { request, cancelled } = streamRequest([chunk, chunk, chunk], {
      "content-length": "10",
    });
    const result = await readBytesResult(request);
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(cancelled()).toBe(true);
  });

  it("rejects a missing body and accepts an empty stream as zero bytes", async () => {
    const missing = new Request("http://localhost/", { method: "POST" });
    expect(await readBytesResult(missing)).toEqual({ ok: false, reason: "invalid" });
    const empty = await readBytesResult(post(""));
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.bytes.byteLength).toBe(0);
    }
  });
});
