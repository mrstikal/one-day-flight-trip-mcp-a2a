import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { nonEmptyStringSchema, type VoiceKind, type VoiceProfilesFile } from "@odft/contracts";
import { compareUsd, parseUsd } from "./costs.js";
import { OPENROUTER_MODELS_URL } from "./capabilities.js";
import { SpeechError } from "./speech-adapter.js";
import {
  compareExactDecimals,
  maxExactDecimal,
  ceilExactToInteger,
  worstCallCostUsd,
  SPEECH_UNIT_BY_KIND,
  type SpeechTariff,
} from "./speech-costs.js";

/**
 * Unit-aware speech capability/pricing snapshot (VOICE_CONTROLL.md sections 5-6).
 *
 * The snapshot is built ONLY by `npm run voice:validate-models` from the public
 * endpoint metadata and stamped into `pricingVersion`; it is never refreshed
 * silently during a user request. It cannot claim Groq enforcement (that stays
 * an assigned-key/operator gate) and it distinguishes documented provider
 * minimums from gateway-published rates.
 */

export const SPEECH_CAPABILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SPEECH_NORMALIZATION_VERSION = "voice-normalization-v1";

export const SPEECH_EXPECTED_MODALITY: Readonly<Record<VoiceKind, string>> = {
  stt: "audio->transcription",
  tts: "text->speech",
};

/**
 * Documented provider minimums (section 5 evidence, e.g. the Groq speech docs
 * "10-second minimum charge"). These are provider documentation facts, NOT
 * gateway-verified: live smoke must confirm the final tariff, and they must
 * never be lowered without new evidence.
 */
const DOCUMENTED_MINIMUM_SECONDS: Readonly<Record<string, string>> = {
  groq: "10",
};

/**
 * The exact documented models and STT endpoint for this feature (section 6).
 * Changing any of them is a new product decision and must be made in code, not
 * silently through an operator profile.
 */
export const DOCUMENTED_SPEECH_MODELS: Readonly<Record<VoiceKind, string>> = {
  stt: "openai/whisper-large-v3-turbo",
  tts: "elevenlabs/eleven-v4-turbo",
};
export const DOCUMENTED_STT_ENDPOINT_PROVIDER_ID = "groq";
export const DOCUMENTED_TTS_VOICE = "george";

const rawDecimalSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a raw nonnegative decimal string");

export const speechCapabilityEntrySchema = z
  .object({
    kind: z.enum(["stt", "tts"]),
    model: nonEmptyStringSchema,
    endpointProviderId: nonEmptyStringSchema,
    providerName: nonEmptyStringSchema,
    modality: nonEmptyStringSchema,
    unit: z.enum(["audio_seconds", "characters"]),
    /** Undiscounted published rate: the safe reservation upper bound. */
    ratePerUnitUsd: rawDecimalSchema,
    /** Published discount fraction, recorded but never subtracted. */
    publishedDiscount: z.string(),
    minimumUnits: rawDecimalSchema,
    minimumUnitsSource: z.enum(["documented-provider-evidence", "none-published", "unknown"]),
    requestFeeUsd: rawDecimalSchema,
    normalizationVersion: nonEmptyStringSchema,
  })
  .strict();
export type SpeechCapabilityEntry = z.infer<typeof speechCapabilityEntrySchema>;

export const speechCapabilityManifestSchema = z
  .object({
    fetchedAt: z.string().min(1),
    pricingVersion: nonEmptyStringSchema,
    stt: speechCapabilityEntrySchema,
    tts: speechCapabilityEntrySchema,
  })
  .strict();
export type SpeechCapabilityManifest = z.infer<typeof speechCapabilityManifestSchema>;

export interface SpeechCapabilityFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type SpeechCapabilityFetch = (
  url: string,
  init?: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<SpeechCapabilityFetchResponse>;

/** Billing-relevant pricing keys; any other component fails closed. */
const ALLOWED_PRICING_KEYS = new Set(["prompt", "completion", "discount", "request", "overrides"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rawDecimalOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) {
    return undefined;
  }
  return value;
}

/** Every variant rate that could be charged: the base plus conditional overrides. */
function worstPromptRate(pricing: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(pricing)) {
    if (!ALLOWED_PRICING_KEYS.has(key)) {
      // An unrecognized pricing component is an unknown tariff: fail closed.
      return undefined;
    }
  }
  const completion = pricing.completion;
  if (typeof completion !== "string" || !/^0+(\.0+)?$/.test(completion)) {
    // Audio endpoints publish no output charge; anything else is unverifiable.
    return undefined;
  }
  const base = rawDecimalOrUndefined(pricing.prompt);
  if (base === undefined) {
    return undefined;
  }
  let worst = base;
  if (pricing.overrides !== undefined) {
    if (!Array.isArray(pricing.overrides)) {
      return undefined;
    }
    for (const override of pricing.overrides) {
      if (
        !isRecord(override) ||
        Object.keys(override).some((key) => !ALLOWED_PRICING_KEYS.has(key))
      ) {
        return undefined;
      }
      const overrideCompletion = override.completion;
      if (
        overrideCompletion !== undefined &&
        (typeof overrideCompletion !== "string" || !/^0+(\.0+)?$/.test(overrideCompletion))
      ) {
        // A conditional output charge is an unverifiable variant: fail closed.
        return undefined;
      }
      const rate = rawDecimalOrUndefined(override.prompt ?? "0");
      if (rate === undefined) {
        return undefined;
      }
      worst = maxExactDecimal(worst, rate);
    }
  }
  return worst;
}

function worstRequestFee(pricing: Record<string, unknown>): string | undefined {
  const fee = rawDecimalOrUndefined(pricing.request ?? "0");
  if (fee === undefined) {
    return undefined;
  }
  let worst = fee;
  if (Array.isArray(pricing.overrides)) {
    for (const override of pricing.overrides) {
      if (!isRecord(override)) {
        continue;
      }
      const candidate = rawDecimalOrUndefined(override.request ?? "0");
      if (candidate === undefined) {
        return undefined;
      }
      worst = maxExactDecimal(worst, candidate);
    }
  }
  return worst;
}

function publishedDiscount(pricing: Record<string, unknown>): string {
  const value = pricing.discount;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
    return value;
  }
  return "unknown";
}

function endpointProviderId(endpoint: Record<string, unknown>): string | undefined {
  return typeof endpoint.tag === "string" && endpoint.tag.length > 0 ? endpoint.tag : undefined;
}

function minimumFor(
  kind: VoiceKind,
  providerId: string,
): {
  minimumUnits: string;
  minimumUnitsSource: SpeechCapabilityEntry["minimumUnitsSource"];
} {
  if (kind === "stt") {
    const documented = DOCUMENTED_MINIMUM_SECONDS[providerId];
    if (documented !== undefined) {
      return { minimumUnits: documented, minimumUnitsSource: "documented-provider-evidence" };
    }
    // No documented minimum for this provider: refuse live transport downstream.
    return { minimumUnits: "0", minimumUnitsSource: "unknown" };
  }
  return { minimumUnits: "0", minimumUnitsSource: "none-published" };
}

/**
 * Normalize one `/api/v1/models/{author}/{slug}/endpoints` payload into a single
 * speech capability entry. Returns `undefined` on ANY verification failure
 * (wrong model/modality/provider, missing or unverifiable pricing) so callers
 * fail closed; it never invents a rate, fee, or minimum.
 *
 * STT pins an exact endpoint tag (`groq`). TTS has no endpoint field in the
 * operator profile, so its metadata must publish exactly one endpoint; a second
 * endpoint would make the tariff ambiguous and fails closed until a new product
 * decision pins it.
 */
export function normalizeSpeechCapability(params: {
  readonly kind: VoiceKind;
  readonly model: string;
  readonly endpointProviderId?: string;
  readonly payload: unknown;
}): SpeechCapabilityEntry | undefined {
  const data =
    isRecord(params.payload) && isRecord(params.payload.data) ? params.payload.data : undefined;
  if (!data) {
    return undefined;
  }
  if (data.id !== params.model) {
    return undefined;
  }
  const architecture = isRecord(data.architecture) ? data.architecture : undefined;
  const modality = architecture?.modality;
  if (modality !== SPEECH_EXPECTED_MODALITY[params.kind]) {
    return undefined;
  }
  const endpoints = (Array.isArray(data.endpoints) ? data.endpoints : []).filter(isRecord);
  let endpoint: Record<string, unknown> | undefined;
  let providerId: string | undefined;
  if (params.endpointProviderId !== undefined) {
    endpoint = endpoints.find(
      (candidate) => endpointProviderId(candidate) === params.endpointProviderId,
    );
    providerId = params.endpointProviderId;
  } else if (endpoints.length === 1) {
    endpoint = endpoints[0];
    providerId = endpoint ? endpointProviderId(endpoint) : undefined;
  }
  if (!endpoint || providerId === undefined) {
    return undefined;
  }
  const pricing = isRecord(endpoint.pricing) ? endpoint.pricing : undefined;
  if (!pricing) {
    return undefined;
  }
  const rate = worstPromptRate(pricing);
  const fee = worstRequestFee(pricing);
  if (rate === undefined || fee === undefined) {
    return undefined;
  }
  const minimum = minimumFor(params.kind, providerId);
  const providerName =
    typeof endpoint.provider_name === "string" && endpoint.provider_name.length > 0
      ? endpoint.provider_name
      : providerId;
  return speechCapabilityEntrySchema.parse({
    kind: params.kind,
    model: params.model,
    endpointProviderId: providerId,
    providerName,
    modality,
    unit: SPEECH_UNIT_BY_KIND[params.kind],
    ratePerUnitUsd: rate,
    publishedDiscount: publishedDiscount(pricing),
    minimumUnits: minimum.minimumUnits,
    minimumUnitsSource: minimum.minimumUnitsSource,
    requestFeeUsd: fee,
    normalizationVersion: SPEECH_NORMALIZATION_VERSION,
  });
}

/** Read-only manifest load; a missing or stale snapshot is refused, never refreshed. */
export function loadSpeechCapabilityManifest(options: {
  readonly cachePath: string;
  readonly now?: Date;
  readonly maxAgeMs?: number;
}): SpeechCapabilityManifest {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? SPEECH_CAPABILITY_CACHE_TTL_MS;
  let manifest: SpeechCapabilityManifest;
  try {
    manifest = speechCapabilityManifestSchema.parse(
      JSON.parse(readFileSync(options.cachePath, "utf8")),
    );
  } catch {
    throw new SpeechError(
      "VOICE_NOT_CONFIGURED",
      "no valid voice capability manifest; run `npm run voice:validate-models` on the server and restart the web process",
    );
  }
  assertSpeechManifestFresh(manifest, now, maxAgeMs);
  assertNormalizationVersion(manifest.stt.normalizationVersion, "stt");
  assertNormalizationVersion(manifest.tts.normalizationVersion, "tts");
  return manifest;
}

function assertNormalizationVersion(version: string, kind: VoiceKind): void {
  if (version !== SPEECH_NORMALIZATION_VERSION) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `the pinned ${kind} tariff uses normalization "${version}", but this build expects "${SPEECH_NORMALIZATION_VERSION}"; run \`npm run voice:validate-models\` and restart the web process`,
    );
  }
}

/**
 * The feature's documented models/endpoint (section 6). Used by the validator
 * so an operator cannot silently swap the product's speech models; changing
 * them is a new product decision that must accompany a code change.
 */
export function assertDocumentedSpeechDefaults(profiles: VoiceProfilesFile): void {
  const issues: string[] = [];
  if (profiles.stt.model !== DOCUMENTED_SPEECH_MODELS.stt) {
    issues.push(
      `stt.model "${profiles.stt.model}" is not the documented model "${DOCUMENTED_SPEECH_MODELS.stt}"`,
    );
  }
  if (profiles.tts.model !== DOCUMENTED_SPEECH_MODELS.tts) {
    issues.push(
      `tts.model "${profiles.tts.model}" is not the documented model "${DOCUMENTED_SPEECH_MODELS.tts}"`,
    );
  }
  if (profiles.stt.endpointProviderId !== DOCUMENTED_STT_ENDPOINT_PROVIDER_ID) {
    issues.push(
      `stt.endpointProviderId "${profiles.stt.endpointProviderId}" is not the documented endpoint "${DOCUMENTED_STT_ENDPOINT_PROVIDER_ID}"`,
    );
  }
  if (profiles.tts.voice !== DOCUMENTED_TTS_VOICE) {
    issues.push(
      `tts.voice "${profiles.tts.voice}" is not the documented voice "${DOCUMENTED_TTS_VOICE}"`,
    );
  }
  if (issues.length > 0) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `the voice profile deviates from the documented defaults; changing them requires a new product decision (VOICE_CONTROLL.md section 6):\n- ${issues.join("\n- ")}`,
    );
  }
}

export function assertSpeechManifestFresh(
  manifest: SpeechCapabilityManifest,
  now: Date = new Date(),
  maxAgeMs: number = SPEECH_CAPABILITY_CACHE_TTL_MS,
): void {
  const fetchedAt = Date.parse(manifest.fetchedAt);
  if (Number.isNaN(fetchedAt) || now.getTime() - fetchedAt >= maxAgeMs) {
    const hours = Math.round(maxAgeMs / 3_600_000);
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `voice capability manifest is older than ${String(hours)} hours; run \`npm run voice:validate-models\` and restart the web process`,
    );
  }
}

export interface RefreshSpeechCapabilityOptions {
  readonly cachePath: string;
  readonly fetchImpl: SpeechCapabilityFetch;
  readonly profiles: VoiceProfilesFile;
  readonly now?: Date;
}

/**
 * Explicit refresh (`npm run voice:validate-models`): fetch both configured
 * models, verify model/modality/endpoint/tariff, and write the snapshot. Any
 * unverifiable model/endpoint fails closed with every diagnostic listed.
 */
export async function refreshSpeechCapabilityManifest(
  options: RefreshSpeechCapabilityOptions,
): Promise<SpeechCapabilityManifest> {
  const now = options.now ?? new Date();
  const pricingVersion = now.toISOString();
  const requested: Array<{ kind: VoiceKind; model: string; endpointProviderId?: string }> = [
    {
      kind: "stt",
      model: options.profiles.stt.model,
      endpointProviderId: options.profiles.stt.endpointProviderId,
    },
    { kind: "tts", model: options.profiles.tts.model },
  ];
  const issues: string[] = [];
  const normalized = new Map<VoiceKind, SpeechCapabilityEntry>();
  for (const request of requested) {
    let payload: unknown;
    try {
      const response = await options.fetchImpl(
        `${OPENROUTER_MODELS_URL}/${request.model}/endpoints`,
      );
      if (!response.ok) {
        issues.push(
          `${request.kind}: ${request.model} endpoint metadata returned HTTP ${String(response.status)}`,
        );
        continue;
      }
      payload = await response.json();
    } catch (error) {
      issues.push(
        `${request.kind}: ${request.model} endpoint metadata transport error (${error instanceof Error ? error.message : "unknown"})`,
      );
      continue;
    }
    const entry = normalizeSpeechCapability({ ...request, payload });
    if (!entry) {
      const target = request.endpointProviderId
        ? `endpoint "${request.endpointProviderId}"`
        : "a single published endpoint";
      issues.push(
        `${request.kind}: ${request.model} is not a verifiable speech model on ${target} (model/modality/endpoint/pricing)`,
      );
      continue;
    }
    normalized.set(request.kind, entry);
  }
  const stt = normalized.get("stt");
  const tts = normalized.get("tts");
  if (!stt || !tts) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `voice model validation failed:\n- ${issues.join("\n- ")}`,
    );
  }
  const manifest = speechCapabilityManifestSchema.parse({
    fetchedAt: pricingVersion,
    pricingVersion,
    stt,
    tts,
  });
  mkdirSync(dirname(options.cachePath), { recursive: true });
  writeFileSync(options.cachePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/**
 * Per-call tariff recheck (section 5): refetch the published endpoint metadata
 * and compare it with the pinned snapshot. Any difference, or a snapshot that
 * is no longer verifiable, refuses transport and requires an explicit
 * `voice:validate-models` + restart — a user request never silently re-pins
 * prices.
 */
export async function revalidateSpeechTariffs(options: {
  readonly manifest: SpeechCapabilityManifest;
  readonly fetchImpl: SpeechCapabilityFetch;
}): Promise<void> {
  const checks: Array<{ kind: VoiceKind; entry: SpeechCapabilityEntry }> = [
    { kind: "stt", entry: options.manifest.stt },
    { kind: "tts", entry: options.manifest.tts },
  ];
  const differences: string[] = [];
  for (const { kind, entry } of checks) {
    let payload: unknown;
    try {
      const response = await options.fetchImpl(`${OPENROUTER_MODELS_URL}/${entry.model}/endpoints`);
      if (!response.ok) {
        differences.push(`${kind}: endpoint metadata returned HTTP ${String(response.status)}`);
        continue;
      }
      payload = await response.json();
    } catch (error) {
      differences.push(
        `${kind}: endpoint metadata transport error (${error instanceof Error ? error.message : "unknown"})`,
      );
      continue;
    }
    const fresh = normalizeSpeechCapability({
      kind,
      model: entry.model,
      // STT re-checks the pinned tag; TTS re-applies the single-endpoint rule so
      // a newly published second endpoint (an ambiguous tariff) is refused, not
      // silently routed to under a stale reservation.
      ...(kind === "stt" ? { endpointProviderId: entry.endpointProviderId } : {}),
      payload,
    });
    if (!fresh) {
      differences.push(
        `${kind}: ${entry.model} is no longer a verifiable single endpoint "${entry.endpointProviderId}"`,
      );
      continue;
    }
    if (fresh.endpointProviderId !== entry.endpointProviderId) {
      differences.push(
        `${kind}: serving endpoint changed from "${entry.endpointProviderId}" to "${fresh.endpointProviderId}"`,
      );
      continue;
    }
    if (
      fresh.unit !== entry.unit ||
      compareExactDecimals(fresh.ratePerUnitUsd, entry.ratePerUnitUsd) !== 0 ||
      compareExactDecimals(fresh.minimumUnits, entry.minimumUnits) !== 0 ||
      compareExactDecimals(fresh.requestFeeUsd, entry.requestFeeUsd) !== 0
    ) {
      differences.push(
        `${kind}: published tariff changed (pinned ${entry.ratePerUnitUsd}/${entry.minimumUnits}/${entry.requestFeeUsd}, published ${fresh.ratePerUnitUsd}/${fresh.minimumUnits}/${fresh.requestFeeUsd})`,
      );
    }
  }
  if (differences.length > 0) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `voice tariffs changed or became unverifiable:\n- ${differences.join("\n- ")}\nrun \`npm run voice:validate-models\` to re-pin and restart the web process`,
    );
  }
}

export interface SpeechCapabilityCheck {
  readonly kind: VoiceKind;
  readonly entry: SpeechCapabilityEntry;
  readonly tariff: SpeechTariff;
  readonly worstCallCostUsd: string;
}

/**
 * Validate the pinned snapshot against one profile kind before any transport:
 * model/endpoint/unit/pricing-version match, a documented minimum (an unknown
 * minimum refuses live transport), and limits that cover the worst possible
 * call at the published rate.
 */
export function assertSpeechCapable(input: {
  readonly profiles: VoiceProfilesFile;
  readonly kind: VoiceKind;
  readonly manifest: SpeechCapabilityManifest;
}): SpeechCapabilityCheck {
  const { profiles, kind, manifest } = input;
  const profile: { model: string; maxCallCostUsd: string } =
    kind === "stt" ? profiles.stt : profiles.tts;
  const entry = kind === "stt" ? manifest.stt : manifest.tts;
  if (entry.model !== profile.model) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `pinned ${kind} model ${entry.model} does not match the profile model ${profile.model}; run \`npm run voice:validate-models\``,
    );
  }
  if (kind === "stt" && entry.endpointProviderId !== profiles.stt.endpointProviderId) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `pinned stt endpoint "${entry.endpointProviderId}" does not match the profile endpoint "${profiles.stt.endpointProviderId}"; run \`npm run voice:validate-models\``,
    );
  }
  if (profiles.pricingVersion !== manifest.pricingVersion) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `pricing version "${profiles.pricingVersion}" does not match the verified manifest version "${manifest.pricingVersion}"; run \`npm run voice:validate-models\` to refresh and stamp it`,
    );
  }
  assertNormalizationVersion(entry.normalizationVersion, kind);
  if (entry.minimumUnitsSource === "unknown") {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `minimum billing for ${kind} provider "${entry.endpointProviderId}" is undocumented and unverified`,
    );
  }
  if (entry.unit !== SPEECH_UNIT_BY_KIND[kind]) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `pinned ${kind} unit "${entry.unit}" does not match the documented billing unit`,
    );
  }
  // Malformed pinned decimals fail closed here (never treated as zero).
  const tariff: SpeechTariff = {
    unit: entry.unit,
    ratePerUnit: entry.ratePerUnitUsd,
    minimumUnits: entry.minimumUnits,
    requestFeeUsd: entry.requestFeeUsd,
  };
  const maxUnits =
    kind === "stt"
      ? Math.max(
          profiles.limits.maxRecordingSeconds,
          ceilExactToInteger(entry.minimumUnits, "minimum billing seconds"),
        )
      : Math.max(
          profiles.limits.maxReplyCharacters,
          ceilExactToInteger(entry.minimumUnits, "minimum billing characters"),
        );
  const worst = worstCallCostUsd(tariff, maxUnits);
  const ceiling = profile.maxCallCostUsd;
  if (compareUsd(parseUsd(worst), parseUsd(ceiling)) > 0) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `${kind} worst-case call ${worst} exceeds the profile ceiling ${ceiling}; raise ${kind}.maxCallCostUsd and re-run \`npm run voice:validate-models\``,
    );
  }
  return { kind, entry, tariff, worstCallCostUsd: worst };
}
