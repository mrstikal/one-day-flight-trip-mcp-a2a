import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { resetRateLimits, startWorker, stopWorker } from "./_worker.js";

/**
 * Browser voice control (VOICE_CONTROLL.md section 15, T-E2E-VOICE-01..12).
 *
 * Real Chromium with a fake microphone fed by the committed synthetic-speech
 * fixtures, the real local Silero VAD, and the real BFF in fixture mode. The
 * fake device/permission flags are scoped to THIS file only; every assertion
 * observes actual selectors, real network requests, and instrumented Web Audio
 * source calls (audible lifecycle without headphones).
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const SPEECH_FIXTURE = fileURLToPath(
  new URL("../fixtures/voice/speech-with-pauses.wav", import.meta.url),
);
/** The server fixture transcript (VOICE_CONTROLL.md section 14, V02). */
const FIXTURE_TRANSCRIPT = "Make the day less exhausting";
const NO_SPEECH_COPY = "No speech was detected. Try again or type your request.";
const PERMISSION_COPY =
  "Microphone access was denied. Allow it in your browser settings or type your request.";
const NO_DEVICE_COPY = "No microphone was found. Connect one or type your request.";
const VAD_UNAVAILABLE_COPY = "Automatic stopping is unavailable. Use Stop recording.";

test.use({
  baseURL: ORIGIN,
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${SPEECH_FIXTURE}`,
    ],
  },
});
test.setTimeout(300_000);

let worker: ChildProcess | undefined;

test.beforeAll(async () => {
  worker = startWorker();
});

// Trip creation (and the voice routes) are rate limited per session/IP; this
// file creates many trips, so buckets reset before EVERY test.
test.beforeEach(async () => {
  await resetRateLimits();
});

test.afterAll(async () => {
  await stopWorker(worker);
});

interface VoiceProbe {
  gum: number;
  trackStops: number;
  bufferSources: number;
  sourceStarts: number;
  sourceStops: number;
  addModuleUrls: string[];
  /** Page-clock timestamp of the first synthesis fetch and reply-row visibility. */
  synthAt: number | null;
  rowAt: number | null;
}

/** Instrument getUserMedia, track stops, and Web Audio sources before app load. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as {
      __voiceProbe: VoiceProbe;
      AudioContext: typeof AudioContext;
      fetch: typeof fetch;
      __probedAC?: typeof AudioContext;
    };
    w.__voiceProbe = {
      gum: 0,
      trackStops: 0,
      bufferSources: 0,
      sourceStarts: 0,
      sourceStops: 0,
      addModuleUrls: [],
      synthAt: null,
      rowAt: null,
    };
    // AudioWorklet module loads are not visible to Playwright's response
    // listeners (they run in the worklet scope), so record the URL here.
    const audioWorkletProto = (
      globalThis as unknown as { AudioWorklet?: { prototype: { addModule: unknown } } }
    ).AudioWorklet?.prototype;
    if (audioWorkletProto) {
      const addModule = audioWorkletProto.addModule as (url: string | URL) => Promise<void>;
      audioWorkletProto.addModule = function (this: unknown, url: string | URL) {
        w.__voiceProbe.addModuleUrls.push(String(url));
        return addModule.call(this, url);
      } as typeof audioWorkletProto.addModule;
    }
    // Page-clock ordering evidence: the first synthesis fetch vs the first
    // settled assistant reply row becoming visible.
    const originalFetch = w.fetch.bind(w);
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const target =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target.includes("/voice/synthesize")) {
        w.__voiceProbe.synthAt ??= Date.now();
      }
      return originalFetch(input, init);
    }) as typeof w.fetch;
    const observer = new MutationObserver(() => {
      if (w.__voiceProbe.rowAt !== null) {
        return;
      }
      if (
        globalThis.document?.querySelector(
          '[data-message-role="assistant"]:not([data-operation-id=""])',
        )
      ) {
        w.__voiceProbe.rowAt = Date.now();
      }
    });
    observer.observe(globalThis.document, { childList: true, subtree: true });
    const mediaDevices = navigator.mediaDevices;
    const gum = mediaDevices.getUserMedia.bind(mediaDevices);
    mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      w.__voiceProbe.gum += 1;
      const stream = await gum(constraints);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          w.__voiceProbe.trackStops += 1;
          stop();
        };
      }
      return stream;
    };
    const BaseAC = w.AudioContext;
    class ProbedAudioContext extends BaseAC {
      override createBufferSource(): AudioBufferSourceNode {
        w.__voiceProbe.bufferSources += 1;
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        source.start = ((...args: Parameters<AudioBufferSourceNode["start"]>) => {
          w.__voiceProbe.sourceStarts += 1;
          return start(...args);
        }) as AudioBufferSourceNode["start"];
        const stop = source.stop.bind(source);
        source.stop = ((...args: Parameters<AudioBufferSourceNode["stop"]>) => {
          w.__voiceProbe.sourceStops += 1;
          return stop(...args);
        }) as AudioBufferSourceNode["stop"];
        return source;
      }
    }
    w.AudioContext = ProbedAudioContext;
  });
});

function probe(page: Page): Promise<VoiceProbe> {
  return page.evaluate(() => (globalThis as unknown as { __voiceProbe: VoiceProbe }).__voiceProbe);
}

interface RequestTracker {
  commands: number;
  transcribe: number;
  synthesize: number;
  synthTimes: number[];
  plugins: string[];
}

function trackRequests(page: Page): RequestTracker {
  const tracker: RequestTracker = {
    commands: 0,
    transcribe: 0,
    synthesize: 0,
    synthTimes: [],
    plugins: [],
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/commands")) {
      tracker.commands += 1;
    }
    if (url.pathname.endsWith("/voice/transcribe")) {
      tracker.transcribe += 1;
    }
    if (url.pathname.endsWith("/voice/synthesize")) {
      tracker.synthesize += 1;
      tracker.synthTimes.push(Date.now());
      tracker.plugins.push(request.postData() ?? "");
    }
  });
  return tracker;
}

async function createTripViaApi(page: Page): Promise<string> {
  const session = await page.request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(session.status());
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const created = await page.request.post("/api/trips", {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      creationRequestId: randomUUID(),
      userName: "Voice Ada",
      adults: 2,
      originAirportId: "ourairports:4408",
      destinationCityId: "geonames:3169070",
      destinationCountryKey: "IT",
      sightseeingDate: "2026-12-01",
      travelVariant: "two_nights",
    },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { tripId: string }).tripId;
}

/** Open a trip page and wait until the (fixture-mode) voice controls resolve. */
async function openRail(page: Page, tripId: string): Promise<void> {
  await page.goto(`/trips/${tripId}/flights`);
  await expect(page.getByTestId("assistant-rail")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("voice-controls")).toBeVisible({ timeout: 30_000 });
}

async function chatValue(page: Page): Promise<string> {
  return page.locator("#assistant-chat").inputValue();
}

test("voice controls mount inactive, ordered below Send, with no microphone access", async ({
  page,
}) => {
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  await openRail(page, tripId);

  // No microphone request and no speech traffic on mount.
  const before = await probe(page);
  expect(before.gum).toBe(0);
  expect(tracker.transcribe).toBe(0);
  expect(tracker.synthesize).toBe(0);

  // Exact English helper immediately BELOW the Send button.
  const helper = page.locator("#assistant-voice-help");
  await expect(helper).toHaveText(
    "Use your microphone and speakers/headphones to control the assistant.",
  );
  // The helper paragraph is the immediate next sibling of the Send button.
  await expect(page.locator('button[type="submit"] + #assistant-voice-help')).toHaveCount(1);
  const controls = page.getByTestId("voice-controls");
  await expect(controls).toHaveAttribute("aria-describedby", "assistant-voice-help");

  // Accessible controls and the activation/privacy notice.
  await expect(page.getByTestId("voice-dictate")).toBeVisible();
  await expect(page.getByTestId("voice-dictate")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("voice-replies-toggle")).not.toBeChecked();
  await expect(page.getByTestId("voice-privacy")).toContainText(
    "Starting dictation also enables spoken replies for this tab.",
  );
  await expect(page.getByTestId("voice-fixture-label")).toContainText("Voice fixture mode");

  // Still no microphone access after rendering everything.
  expect((await probe(page)).gum).toBe(0);
});

test("manual dictation appends once to the preserved draft and never sends chat", async ({
  page,
}) => {
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  await openRail(page, tripId);

  const composer = page.locator("#assistant-chat");
  await composer.fill("Keep my draft");
  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-dictate")).toHaveText("Stop recording");
  await expect(page.getByTestId("voice-dictate")).toHaveAttribute("aria-pressed", "true");
  // A request can never submit a partially changing draft.
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.getByTestId("voice-dictate").click(); // manual stop
  await expect
    .poll(async () => chatValue(page), { timeout: 60_000, intervals: [500] })
    .toContain(FIXTURE_TRANSCRIPT);
  await expect(page.getByTestId("voice-dictate")).toHaveText("Dictate");

  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  const value = await chatValue(page);
  expect(value).toBe(`Keep my draft ${FIXTURE_TRANSCRIPT}`);
  // Focused composer without page scroll side effects.
  await expect(page.locator("#assistant-chat")).toBeFocused();
  expect(tracker.transcribe).toBe(1);
  expect(tracker.commands).toBe(0);
});

test("the 2,000-character limit keeps the draft and shows the voice alert", async ({ page }) => {
  const tripId = await createTripViaApi(page);
  await openRail(page, tripId);
  const composer = page.locator("#assistant-chat");
  await composer.fill("x".repeat(1990));
  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-dictate")).toHaveText("Stop recording");
  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-insertion-error")).toHaveText(
    "The transcript would exceed the 2,000-character message limit. Shorten your draft and try again.",
    { timeout: 60_000 },
  );
  expect(await chatValue(page)).toBe("x".repeat(1990));
});

test("valid speech plus the configured pause stops automatically and transcribes exactly once", async ({
  page,
}) => {
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  await openRail(page, tripId);

  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-dictate")).toHaveText("Stop recording");
  // Never touch Stop: the VAD completes the dictation by itself (~10 s in the
  // fixture timeline: speech B ends ≈7.4 s, +2 s silence + processing).
  await expect
    .poll(async () => chatValue(page), { timeout: 60_000, intervals: [500] })
    .toContain(FIXTURE_TRANSCRIPT);
  expect(await chatValue(page)).toBe(FIXTURE_TRANSCRIPT);
  expect(tracker.transcribe).toBe(1);
  expect(tracker.commands).toBe(0);
  await expect(page.getByTestId("voice-dictate")).toHaveText("Dictate");
});

test("initial silence and a shorter internal pause never end the query early", async ({ page }) => {
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  await openRail(page, tripId);

  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-dictate")).toHaveText("Stop recording");
  // Initial silence is 2.65 s: still recording just before it ends.
  await page.waitForTimeout(1_900);
  await expect(page.getByTestId("voice-dictate")).toHaveText("Stop recording");
  expect(tracker.transcribe).toBe(0);
  // Inside the 1.25 s pause between the two phrases (~4.7 s): still one capture.
  await page.waitForTimeout(2_800);
  await expect(page.getByTestId("voice-dictate")).toHaveText("Stop recording");
  expect(tracker.transcribe).toBe(0);
  // Renewed speech then completes exactly once.
  await expect
    .poll(async () => chatValue(page), { timeout: 60_000, intervals: [500] })
    .toContain(FIXTURE_TRANSCRIPT);
  expect(tracker.transcribe).toBe(1);
});

test("a settled linked reply is synthesized exactly once, only after its message appears", async ({
  page,
}) => {
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  await openRail(page, tripId);

  // Replies for typed messages do not require microphone access.
  await page.getByTestId("voice-replies-toggle").check();
  await expect(page.getByTestId("voice-replies-toggle")).toBeChecked();

  await page.locator("#assistant-chat").fill("Make the day less exhausting");
  await page.getByRole("button", { name: "Send" }).click();

  // Zero TTS while the work is accepted/running: the page-clock probe records
  // the FIRST synthesis fetch and the FIRST visibility of a settled linked
  // reply row; synthesis must never precede the visible message.
  await expect.poll(() => tracker.synthesize, { timeout: 120_000 }).toBe(1);
  const orderProbe = await probe(page);
  expect(orderProbe.rowAt).not.toBeNull();
  expect(orderProbe.synthAt).not.toBeNull();
  expect(
    (orderProbe.synthAt ?? 0) >= (orderProbe.rowAt ?? 0),
    `synthesis at ${String(orderProbe.synthAt)} must not precede the reply row at ${String(orderProbe.rowAt)}`,
  ).toBe(true);
  await expect
    .poll(async () => (await probe(page)).sourceStarts, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);

  // Re-renders, SSE replays, and bounded refresh never repeat the speech.
  await page.waitForTimeout(6_000);
  expect(tracker.synthesize).toBe(1);
  expect((await probe(page)).sourceStarts).toBe(1);
});

test("synthesis receives only the message id — never list or card text", async ({ page }) => {
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  await openRail(page, tripId);
  await page.getByTestId("voice-replies-toggle").check();
  await page.locator("#assistant-chat").fill("Make the day less exhausting");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => tracker.synthesize, { timeout: 150_000 }).toBe(1);
  const body = JSON.parse(tracker.plugins[0] ?? "{}") as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["messageId", "requestId"]);
  const messageRow = page.locator(`[data-message-id="${String(body.messageId)}"]`);
  await expect(messageRow).toBeVisible();
  const content = await messageRow.getByTestId("conversation-message-content").textContent();
  expect((content ?? "").trim().length).toBeGreaterThan(0);
  // The rendered reply text never travels in the browser request payload
  // (the exact upstream-input exclusion lives in the V04 integration test).
  expect(tracker.plugins[0]).not.toContain((content ?? "").trim());
});

test("cancelling dictation stops the tracks, inserts nothing, and keeps the draft", async ({
  page,
}) => {
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  await openRail(page, tripId);
  await page.locator("#assistant-chat").fill("unchanged");
  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-dictate")).toHaveText("Stop recording");
  await page.getByTestId("voice-cancel").click();
  await expect(page.getByTestId("voice-dictate")).toHaveText("Dictate");
  expect(await chatValue(page)).toBe("unchanged");
  expect(tracker.transcribe).toBe(0);
  await expect
    .poll(async () => (await probe(page)).trackStops, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  // Toggling replies on/off and starting dictation again stays safe.
  await page.getByTestId("voice-replies-toggle").check();
  await page.getByTestId("voice-replies-toggle").uncheck();
  await page.getByTestId("voice-dictate").click();
  await page.getByTestId("voice-cancel").click();
  expect(tracker.commands).toBe(0);
});

test("voice actions never submit the form or leave error states untyped-chat compatible", async ({
  page,
}) => {
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  await openRail(page, tripId);

  // A provider failure surfaces the copy and preserves the typed draft.
  await page.route("**/voice/transcribe", async (route) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        code: "VOICE_NO_SPEECH",
        message: "no speech was detected in the recording",
        retryable: false,
      }),
    });
  });
  await page.locator("#assistant-chat").fill("typed draft survives");
  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-dictate")).toHaveText("Stop recording");
  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-error")).toHaveText(NO_SPEECH_COPY, { timeout: 60_000 });
  expect(await chatValue(page)).toBe("typed draft survives");

  // The suffix buttons never submitted the form on their own.
  expect(tracker.commands).toBe(0);
  await page.getByTestId("voice-replies-toggle").check();
  expect(tracker.commands).toBe(0);
  // Typed chat still works after the voice error.
  await page.unroute("**/voice/transcribe");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => tracker.commands, { timeout: 30_000 }).toBe(1);
});

test("VAD asset failure keeps manual dictation and reports the manual-mode copy", async ({
  page,
}) => {
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  await page.route("**/voice-vad/silero_vad_v5.onnx", (route) => route.abort());
  await openRail(page, tripId);

  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-status")).toHaveText(VAD_UNAVAILABLE_COPY, {
    timeout: 30_000,
  });
  await page.getByTestId("voice-dictate").click(); // manual stop still works
  await expect
    .poll(async () => chatValue(page), { timeout: 60_000, intervals: [500] })
    .toContain(FIXTURE_TRANSCRIPT);
  expect(tracker.transcribe).toBe(1);
});

test("production VAD assets load same-origin with real content", async ({ page }) => {
  const tripId = await createTripViaApi(page);
  const assets: Array<{ url: string; origin: string; status: number; type: string }> = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/voice-vad/")) {
      assets.push({
        url: url.pathname,
        origin: url.origin,
        status: response.status(),
        type: response.headers()["content-type"] ?? "",
      });
    }
  });
  await openRail(page, tripId);
  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-dictate")).toHaveText("Stop recording");
  // The ONNX session loads first, then the AudioWorklet bundle.
  await expect
    .poll(async () => (await probe(page)).addModuleUrls, { timeout: 30_000 })
    .toContain("/voice-vad/vad.worklet.bundle.min.js");
  for (const asset of assets) {
    expect(asset.status).toBe(200);
    expect(asset.type).not.toContain("text/html");
    // Strictly same-origin: no CDN or third-party host may serve these assets.
    expect(asset.origin, `asset ${asset.url} must be same-origin`).toBe(new URL(ORIGIN).origin);
  }
  // The worklet bundle itself must be a real same-origin asset (not HTML).
  const workletResponse = await page.request.get(`${ORIGIN}/voice-vad/vad.worklet.bundle.min.js`);
  expect(workletResponse.status()).toBe(200);
  expect(workletResponse.headers()["content-type"] ?? "").not.toContain("text/html");
  await page.getByTestId("voice-cancel").click();
});

test.describe("microphone device failures", () => {
  // The fake-UI flag auto-grants at the browser level, so the denial paths are
  // simulated deterministically at the Web API the app actually calls.
  async function expectCaptureError(
    page: Page,
    rejection: { name: string },
    copy: string,
  ): Promise<void> {
    await page.addInitScript((denial) => {
      const w = globalThis as unknown as { __voiceProbe?: { gum: number } };
      const mediaDevices = navigator.mediaDevices;
      mediaDevices.getUserMedia = async () => {
        if (w.__voiceProbe) {
          w.__voiceProbe.gum += 1;
        }
        throw new DOMException("simulated", denial.name);
      };
    }, rejection);
    const tripId = await createTripViaApi(page);
    await openRail(page, tripId);
    await page.locator("#assistant-chat").fill("still typed");
    await page.getByTestId("voice-dictate").click();
    await expect(page.getByTestId("voice-error")).toHaveText(copy, { timeout: 30_000 });
    expect(await chatValue(page)).toBe("still typed");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await expect(page.getByTestId("voice-dictate")).toHaveText("Dictate");
  }

  test("a denied microphone exposes the exact permission copy", async ({ page }) => {
    await expectCaptureError(page, { name: "NotAllowedError" }, PERMISSION_COPY);
  });

  test("a missing device exposes the exact no-device copy", async ({ page }) => {
    await expectCaptureError(page, { name: "NotFoundError" }, NO_DEVICE_COPY);
  });
});

test("the 60-second hard cap stays effective without VAD confirmation (desktop only)", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "60 s wall-clock cap runs on desktop only");
  const tracker = trackRequests(page);
  const tripId = await createTripViaApi(page);
  // Manual mode (automatic stopping unavailable). A FAILED detector is unknown
  // activity, never proof of silence, so the hard limit must finalize and
  // transcribe the captured audio instead of discarding it. (The bounded-timer
  // notice and the healthy-detector discard are covered by the unit tests.)
  await page.route("**/voice-vad/silero_vad_v5.onnx", (route) => route.abort());
  await openRail(page, tripId);
  await page.getByTestId("voice-dictate").click();
  await expect(page.getByTestId("voice-status")).toHaveText(VAD_UNAVAILABLE_COPY, {
    timeout: 30_000,
  });
  await expect
    .poll(async () => chatValue(page), { timeout: 90_000, intervals: [1_000] })
    .toContain(FIXTURE_TRANSCRIPT);
  expect(tracker.transcribe).toBe(1);
  await expect(page.getByTestId("voice-dictate")).toHaveText("Dictate");
  await expect
    .poll(async () => (await probe(page)).trackStops, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
});
