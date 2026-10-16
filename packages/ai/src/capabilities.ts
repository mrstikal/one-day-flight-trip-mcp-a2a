import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { nonEmptyStringSchema, usdDecimalSchema, type RoleProfile } from "@odft/contracts";
import { AdapterError } from "./adapter.js";
import { compareUsd, formatUsd, parseUsd } from "./costs.js";

/**
 * Cached OpenRouter capability/pricing manifest (06-ai-agent-design.md section 3).
 *
 * Unknown capability or pricing fails closed BEFORE any billable call; base-only
 * or ambiguous pricing is refused, never billed. Fixture tests stub this metadata
 * and never query the network.
 */

export const CAPABILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export const capabilityEndpointSchema = z
  .object({
    providerId: nonEmptyStringSchema,
    supportsStructuredOutputs: z.boolean(),
    supportsReasoning: z.boolean().optional(),
    supportsTemperature: z.boolean().optional(),
    inputPriceUsdPerMillion: usdDecimalSchema,
    outputPriceUsdPerMillion: usdDecimalSchema,
    requestPriceUsd: usdDecimalSchema,
    pricingVersion: nonEmptyStringSchema,
  })
  .strict();
export type CapabilityEndpoint = z.infer<typeof capabilityEndpointSchema>;

export const capabilityEntrySchema = z
  .object({
    model: nonEmptyStringSchema,
    endpoints: z.array(capabilityEndpointSchema).min(1),
  })
  .strict();

export const capabilityManifestSchema = z
  .object({
    fetchedAt: z.string().min(1),
    pricingVersion: nonEmptyStringSchema,
    models: z.record(z.string(), capabilityEntrySchema),
  })
  .strict();
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

export interface CapabilityFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type CapabilityFetch = (
  url: string,
  init?: { readonly headers?: Record<string, string> },
) => Promise<CapabilityFetchResponse>;

function perTokenToMillion(value: string): string {
  // USD/token (scaled 1e9) -> USD per million tokens (scaled 1e9) = value * 1e6.
  return formatUsd(parseUsd(value) * 1_000_000n);
}

function maxUsd(a: string, b: string): string {
  return compareUsd(parseUsd(a), parseUsd(b)) >= 0 ? a : b;
}

function usdOrZero(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return "0";
  }
  if (typeof value !== "string") {
    // A present-but-malformed component must fail closed, never bill as zero.
    return undefined;
  }
  try {
    parseUsd(value);
    return value;
  } catch {
    return undefined;
  }
}

function addUsdStrings(a: string, b: string): string {
  return formatUsd(parseUsd(a) + parseUsd(b));
}

/**
 * Component-wise maximum across the base rate and every conditional override.
 * Returns undefined when a present component is malformed (fail closed).
 */
function worstComponent(
  candidates: readonly Record<string, unknown>[],
  key: string,
): string | undefined {
  let worst = "0";
  for (const candidate of candidates) {
    const value = usdOrZero(candidate[key]);
    if (value === undefined) {
      return undefined;
    }
    worst = maxUsd(worst, value);
  }
  return worst;
}

/**
 * Additive worst-case per token plus the per-request components.
 *
 * `pricing.overrides` are conditional variants (peak windows, token thresholds);
 * taking the component-wise maximum over the base rate and every override is the
 * verified upper bound the reservation must use. `web_search` is billed per
 * search, not per token, so it joins the per-request component.
 */
function worstCasePerToken(pricing: Record<string, unknown>): {
  input: string;
  output: string;
  request: string;
} | undefined {
  const overrides = Array.isArray(pricing.overrides)
    ? (pricing.overrides as unknown[]).filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const candidates = [pricing, ...overrides];
  const hasPricing = candidates.some(
    (candidate) =>
      typeof candidate.prompt === "string" && typeof candidate.completion === "string",
  );
  if (!hasPricing) {
    return undefined;
  }
  const prompt = worstComponent(candidates, "prompt");
  const completion = worstComponent(candidates, "completion");
  const cacheRead = worstComponent(candidates, "input_cache_read");
  const cacheWrite = worstComponent(candidates, "input_cache_write");
  const cacheWrite1h = worstComponent(candidates, "input_cache_write_1h");
  const reasoning = worstComponent(candidates, "internal_reasoning");
  const request = worstComponent(candidates, "request");
  const webSearch = worstComponent(candidates, "web_search");
  if (
    prompt === undefined ||
    completion === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cacheWrite1h === undefined ||
    reasoning === undefined ||
    request === undefined ||
    webSearch === undefined
  ) {
    return undefined;
  }
  const cacheWorst = maxUsd(maxUsd(cacheRead, cacheWrite), cacheWrite1h);
  return {
    input: addUsdStrings(prompt, cacheWorst),
    output: addUsdStrings(completion, reasoning),
    // `web_search` is billed per search, so it joins the per-request component.
    request: addUsdStrings(request, webSearch),
  };
}

/**
 * Normalize one `/api/v1/models/{author}/{slug}/endpoints` payload. The provider
 * id is the real endpoint provider slug (`tag`, else `provider_name`), never the
 * model author prefix, and the rates are the additive worst case per endpoint.
 */
export function normalizeEndpointEntry(
  modelId: string,
  payload: unknown,
  pricingVersion: string,
): z.infer<typeof capabilityEntrySchema> | undefined {
  const data = (payload as { data?: unknown })?.data as Record<string, unknown> | undefined;
  const endpoints = Array.isArray(data?.endpoints) ? (data.endpoints as unknown[]) : [];
  const normalized: CapabilityEndpoint[] = [];
  for (const raw of endpoints) {
    const record = raw as Record<string, unknown>;
    // `tag` is the documented provider slug; a display name is only accepted when
    // it is already slug-shaped (lowercase, no spaces).
    const providerId = [record.tag, record.provider_name, record.name].find(
      (value): value is string =>
        typeof value === "string" && /^[a-z0-9][a-z0-9._:/-]*$/.test(value),
    );
    if (!providerId) {
      continue;
    }
    const supported = Array.isArray(record.supported_parameters)
      ? record.supported_parameters.filter((value): value is string => typeof value === "string")
      : [];
    const worst = worstCasePerToken((record.pricing ?? {}) as Record<string, unknown>);
    if (!worst) {
      continue;
    }
    try {
      normalized.push({
        providerId,
        supportsStructuredOutputs:
          supported.includes("structured_outputs") || supported.includes("response_format"),
        supportsReasoning: supported.includes("reasoning"),
        supportsTemperature: supported.includes("temperature"),
        inputPriceUsdPerMillion: perTokenToMillion(worst.input),
        outputPriceUsdPerMillion: perTokenToMillion(worst.output),
        requestPriceUsd: formatUsd(parseUsd(worst.request)),
        pricingVersion,
      });
    } catch {
      // Malformed pricing for this endpoint: omit it and fail closed if nothing remains.
    }
  }
  if (normalized.length === 0) {
    return undefined;
  }
  return capabilityEntrySchema.parse({ model: modelId, endpoints: normalized });
}

export interface RefreshCapabilityOptions {
  readonly cachePath: string;
  readonly fetchImpl: CapabilityFetch;
  readonly now?: Date;
  readonly apiKey?: string;
  /** Exactly the configured profile models to fetch endpoint capability for. */
  readonly models: readonly string[];
}

/**
 * Explicit refresh (`npm run ai:validate-models`): fetch the endpoint list for
 * each configured model and record every provider's additive worst-case rates.
 * Never called by fixture tests.
 */
export async function refreshCapabilityManifest(
  options: RefreshCapabilityOptions,
): Promise<CapabilityManifest> {
  const now = options.now ?? new Date();
  const pricingVersion = now.toISOString();
  const headers: Record<string, string> = options.apiKey
    ? { authorization: `Bearer ${options.apiKey}` }
    : {};
  const models: Record<string, z.infer<typeof capabilityEntrySchema>> = {};
  const skipped: string[] = [];
  for (const model of [...new Set(options.models)]) {
    let response: CapabilityFetchResponse;
    try {
      response = await options.fetchImpl(`${OPENROUTER_MODELS_URL}/${model}/endpoints`, {
        headers,
      });
    } catch (error) {
      skipped.push(`${model}: transport error (${error instanceof Error ? error.message : "unknown"})`);
      continue;
    }
    if (!response.ok) {
      skipped.push(`${model}: HTTP ${response.status}`);
      continue;
    }
    const entry = normalizeEndpointEntry(model, await response.json(), pricingVersion);
    if (entry) {
      models[model] = entry;
    } else {
      skipped.push(`${model}: no endpoint with usable structured-output capability and pricing`);
    }
  }
  if (Object.keys(models).length === 0) {
    throw new AdapterError(
      "AI_CAPABILITY_UNKNOWN",
      `no configured model returned usable endpoint capability and pricing (${skipped.join("; ")})`,
    );
  }
  const manifest = capabilityManifestSchema.parse({ fetchedAt: pricingVersion, pricingVersion, models });
  mkdirSync(dirname(options.cachePath), { recursive: true });
  writeFileSync(options.cachePath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

export interface LoadCapabilityOptions {
  readonly cachePath: string;
  readonly models: readonly string[];
  readonly now?: Date;
  readonly maxAgeMs?: number;
  readonly fetchImpl?: CapabilityFetch;
  readonly apiKey?: string;
}

/**
 * Load the cached manifest. A usable cache (fresh and covering every configured
 * model) is returned as-is. Otherwise the manifest is refreshed over the network
 * only when a `fetchImpl` is supplied (the explicit `ai:validate-models` path);
 * a caller that forbids network access fails closed with an actionable error
 * instead, so an automatic refresh can never invalidate the operator-stamped
 * profile `pricingVersion` pins.
 */
export async function loadCapabilityManifest(
  options: LoadCapabilityOptions,
): Promise<CapabilityManifest> {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? CAPABILITY_CACHE_TTL_MS;
  let cached: CapabilityManifest | undefined;
  try {
    cached = capabilityManifestSchema.parse(JSON.parse(readFileSync(options.cachePath, "utf8")));
  } catch {
    cached = undefined;
  }
  if (cached) {
    const uncovered = options.models.filter((model) => cached.models[model] === undefined);
    const ageMs = now.getTime() - Date.parse(cached.fetchedAt);
    if (uncovered.length === 0 && ageMs < maxAgeMs) {
      return cached;
    }
    if (!options.fetchImpl) {
      throw new AdapterError(
        "AI_CAPABILITY_UNKNOWN",
        uncovered.length > 0
          ? `cached capability manifest does not cover configured model(s) ${uncovered.join(", ")}; run \`npm run ai:validate-models\` to refresh and stamp the profiles`
          : `cached capability manifest is stale (fetched ${cached.fetchedAt}); run \`npm run ai:validate-models\` to refresh and stamp the profiles`,
      );
    }
  } else if (!options.fetchImpl) {
    throw new AdapterError(
      "AI_CAPABILITY_UNKNOWN",
      `no cached capability manifest at ${options.cachePath}; run \`npm run ai:validate-models\` to create and verify it`,
    );
  }
  return refreshCapabilityManifest({
    cachePath: options.cachePath,
    fetchImpl: options.fetchImpl,
    models: options.models,
    now,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
}

/**
 * `provider.only` accepts a base provider slug and OpenRouter may then route to any
 * of its variants (`deepinfra/turbo`, `azure/swedencentral`), so capability and
 * pricing verification must cover those variants too — otherwise a call could be
 * routed to an endpoint whose rates were never included in the reserved ceiling.
 */
function providerMatches(endpointProviderId: string, allowed: string): boolean {
  return endpointProviderId === allowed || endpointProviderId.startsWith(`${allowed}/`);
}

export interface CapabilityCheck {
  readonly model: string;
  readonly endpoints: CapabilityEndpoint[];
  readonly worstInputPriceUsdPerMillion: string;
  readonly worstOutputPriceUsdPerMillion: string;
  readonly worstRequestPriceUsd: string;
}

/**
 * Validate a profile against the cached manifest. Throws a typed `AdapterError`
 * before any transport: unknown model/endpoint capability, unsupported explicit
 * settings, or base-only/ambiguous pricing all fail closed.
 */
export function assertModelCapable(
  profile: RoleProfile,
  manifest: CapabilityManifest,
): CapabilityCheck {
  const entry = manifest.models[profile.model];
  if (!entry) {
    throw new AdapterError(
      "AI_CAPABILITY_UNKNOWN",
      `model ${profile.model} is not present in the capability manifest`,
    );
  }
  const matched = entry.endpoints.filter((endpoint) =>
    profile.allowedEndpointProviderIds.some((allowed) =>
      providerMatches(endpoint.providerId, allowed),
    ),
  );
  if (matched.length === 0) {
    // Name the provider slugs that actually serve this model so the operator can
    // fill in `allowedEndpointProviderIds` instead of guessing.
    const available = entry.endpoints.map(
      (endpoint) =>
        `${endpoint.providerId}${endpoint.supportsStructuredOutputs ? "" : " (no structured outputs)"}`,
    );
    throw new AdapterError(
      "AI_CAPABILITY_UNKNOWN",
      `model ${profile.model} has no endpoint from the allowed providers; available: ${available.join(", ")}`,
    );
  }
  const structured = matched.filter((endpoint) => endpoint.supportsStructuredOutputs);
  if (structured.length === 0) {
    throw new AdapterError(
      "AI_CAPABILITY_UNKNOWN",
      `model ${profile.model} has no verified endpoint supporting structured outputs`,
    );
  }
  if (profile.reasoningEffort && !structured.some((endpoint) => endpoint.supportsReasoning)) {
    throw new AdapterError(
      "AI_UNSUPPORTED",
      `model ${profile.model} does not support the configured reasoning effort`,
    );
  }
  // Routing uses `require_parameters`, so ANY parameter the matched endpoints do not
  // publish makes the whole request unroutable (HTTP 404, AI_UNSUPPORTED). Refuse it
  // before billing instead: `temperature` must be dropped or the model swapped.
  if (profile.temperature !== undefined && !structured.some((endpoint) => endpoint.supportsTemperature)) {
    throw new AdapterError(
      "AI_UNSUPPORTED",
      `model ${profile.model} does not publish a temperature parameter on any verified endpoint; remove the profile temperature or choose a model that supports it`,
    );
  }
  const mismatched = structured.filter(
    (endpoint) => endpoint.pricingVersion !== profile.pricingVersion,
  );
  if (mismatched.length > 0) {
    throw new AdapterError(
      "AI_PRICING_UNKNOWN",
      `pricing version "${profile.pricingVersion}" for model ${profile.model} does not match the verified manifest version "${manifest.pricingVersion}"; run \`npm run ai:validate-models\` to refresh and stamp it`,
    );
  }
  const worst = (key: keyof CapabilityEndpoint): string => {
    let worstValue = "0";
    for (const endpoint of structured) {
      const candidate = endpoint[key];
      if (typeof candidate !== "string") {
        throw new AdapterError("AI_PRICING_UNKNOWN", `endpoint pricing ${key} is not a USD string`);
      }
      if (compareUsd(parseUsd(candidate), parseUsd(worstValue)) > 0) {
        worstValue = candidate;
      }
    }
    return worstValue;
  };
  const worstInput = worst("inputPriceUsdPerMillion");
  const worstOutput = worst("outputPriceUsdPerMillion");
  const worstRequest = worst("requestPriceUsd");
  if (compareUsd(parseUsd(profile.inputPriceUsdPerMillion), parseUsd(worstInput)) < 0) {
    throw new AdapterError(
      "AI_PRICING_UNKNOWN",
      `profile inputPriceUsdPerMillion for ${profile.model} is below the published rate; configure at least ${worstInput}`,
    );
  }
  if (compareUsd(parseUsd(profile.outputPriceUsdPerMillion), parseUsd(worstOutput)) < 0) {
    throw new AdapterError(
      "AI_PRICING_UNKNOWN",
      `profile outputPriceUsdPerMillion for ${profile.model} is below the published rate; configure at least ${worstOutput}`,
    );
  }
  if (compareUsd(parseUsd(profile.requestPriceUsd), parseUsd(worstRequest)) < 0) {
    throw new AdapterError(
      "AI_PRICING_UNKNOWN",
      `profile requestPriceUsd for ${profile.model} is below the published fee; configure at least ${worstRequest}`,
    );
  }
  return {
    model: profile.model,
    endpoints: structured,
    worstInputPriceUsdPerMillion: worstInput,
    worstOutputPriceUsdPerMillion: worstOutput,
    worstRequestPriceUsd: worstRequest,
  };
}
