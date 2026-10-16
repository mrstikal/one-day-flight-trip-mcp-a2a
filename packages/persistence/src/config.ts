import { z } from "zod";

/**
 * Strict, server-side runtime configuration for the AI Travel Planner.
 *
 * Configuration is parsed once at process start and fails with an actionable
 * error instead of a partially usable object. Values here are server secrets
 * and must never be exposed to the browser or logged verbatim.
 */

export type AiMode = "fixture" | "openrouter";

export interface ServerConfig {
  readonly databaseUrl: string;
  readonly publicBaseUrl: string;
  readonly sessionHmacKey: string;
  readonly aiMode: AiMode;
  readonly openrouterApiKey: string | undefined;
  readonly aiConfigPath: string | undefined;
  readonly maxPlanningAttempts: number;
  readonly maxProviderAttempts: number;
  readonly maxLlmCallsPerTrip: number;
  readonly maxLlmCostUsdPerTrip: number;
  readonly demoControlsEnabled: boolean;
  /**
   * On-demand landmark curation: when a trip targets a `generic_only` city, look
   * its landmarks up from Wikidata once, persist them and mark the city curated.
   * Off in tests (the default); the reference tables are otherwise never fetched
   * online.
   */
  readonly wikidataDiscovery: boolean;
  readonly mapTileUrl: string | undefined;
  readonly workerConcurrency: number;
  /** Trust `X-Forwarded-For`/`X-Real-IP` for client IP (only behind a known proxy). */
  readonly trustProxy: boolean;
  /** Voice control is opt-in and off by default (VOICE_CONTROLL.md section 6). */
  readonly voiceEnabled: boolean;
  /** Operator voice profile file; required by live voice, never by other routes. */
  readonly voiceConfigPath: string | undefined;
  /** Dedicated STT key; never the shared `OPENROUTER_API_KEY` (section 5). */
  readonly openrouterSttApiKey: string | undefined;
}

/** Configuration error whose message never contains secret values. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid server configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const booleanString = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((value) => value === "true" || value === "1" || value === "yes");

/** Treat an empty/whitespace string as "unset" so it cannot coerce to 0. */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const intEnv = (min: number, max: number, def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

const floatEnv = (min: number, max: number, def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(min).max(max).default(def));

const rawSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    PUBLIC_BASE_URL: z.string().min(1, "PUBLIC_BASE_URL is required"),
    SESSION_HMAC_KEY: z
      .string()
      .min(32, "SESSION_HMAC_KEY must be at least 32 characters"),
    AI_MODE: z.enum(["fixture", "openrouter"]).default("fixture"),
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    AI_CONFIG_PATH: z.string().min(1).optional(),
    MAX_PLANNING_ATTEMPTS: intEnv(1, 10, 3),
    MAX_PROVIDER_ATTEMPTS: intEnv(1, 10, 2),
    MAX_LLM_CALLS_PER_TRIP: intEnv(1, 1000, 40),
    MAX_LLM_COST_USD_PER_TRIP: floatEnv(0, 1000, 1.0),
    DEMO_CONTROLS_ENABLED: booleanString.optional(),
    WIKIDATA_DISCOVERY: booleanString.optional(),
    MAP_TILE_URL: z.string().min(1).optional(),
    WORKER_CONCURRENCY: intEnv(1, 16, 2),
    TRUST_PROXY: booleanString.optional(),
    VOICE_ENABLED: z.preprocess(emptyToUndefined, booleanString.optional()),
    VOICE_CONFIG_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    OPENROUTER_STT_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  })
  .superRefine((value, ctx) => {
    if (value.AI_MODE === "openrouter" && !value.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENROUTER_API_KEY"],
        message: "OPENROUTER_API_KEY is required when AI_MODE=openrouter",
      });
    }
  });

function assertHttpUrl(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError([`${name} must be a valid absolute URL`]);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError([`${name} must use http or https`]);
  }
}

/**
 * The map tile URL is exposed verbatim to every browser session, so it must be a
 * credential-free, policy-compliant source (10-security-reliability.md section 7):
 * userinfo is rejected outright and plain HTTP only when the app itself is served
 * over HTTP (local development).
 */
function assertPublicTileUrl(value: string, publicBaseUrl: string): void {
  assertHttpUrl("MAP_TILE_URL", value);
  const parsed = new URL(value);
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigError(["MAP_TILE_URL must not contain credentials"]);
  }
  const appIsHttps = new URL(publicBaseUrl).protocol === "https:";
  if (appIsHttps && parsed.protocol !== "https:") {
    throw new ConfigError(["MAP_TILE_URL must use https when the app is served over https"]);
  }
}

function assertPostgresUrl(value: string): void {
  if (!/^postgres(ql)?:\/\//.test(value)) {
    throw new ConfigError(["DATABASE_URL must be a postgres:// or postgresql:// URL"]);
  }
}

/**
 * Parse and validate the server environment. Unknown keys are ignored.
 *
 * @throws {ConfigError} with a sanitized, actionable list of problems.
 */
export function parseServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = rawSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(issues);
  }

  const raw = result.data;
  assertPostgresUrl(raw.DATABASE_URL);
  assertHttpUrl("PUBLIC_BASE_URL", raw.PUBLIC_BASE_URL);
  if (raw.MAP_TILE_URL !== undefined) {
    assertPublicTileUrl(raw.MAP_TILE_URL, raw.PUBLIC_BASE_URL);
  }

  return {
    databaseUrl: raw.DATABASE_URL,
    publicBaseUrl: raw.PUBLIC_BASE_URL,
    sessionHmacKey: raw.SESSION_HMAC_KEY,
    aiMode: raw.AI_MODE,
    openrouterApiKey: raw.OPENROUTER_API_KEY,
    aiConfigPath: raw.AI_CONFIG_PATH,
    maxPlanningAttempts: raw.MAX_PLANNING_ATTEMPTS,
    maxProviderAttempts: raw.MAX_PROVIDER_ATTEMPTS,
    maxLlmCallsPerTrip: raw.MAX_LLM_CALLS_PER_TRIP,
    maxLlmCostUsdPerTrip: raw.MAX_LLM_COST_USD_PER_TRIP,
    demoControlsEnabled: raw.DEMO_CONTROLS_ENABLED ?? false,
    wikidataDiscovery: raw.WIKIDATA_DISCOVERY ?? false,
    mapTileUrl: raw.MAP_TILE_URL,
    workerConcurrency: raw.WORKER_CONCURRENCY,
    trustProxy: raw.TRUST_PROXY ?? false,
    voiceEnabled: raw.VOICE_ENABLED ?? false,
    voiceConfigPath: raw.VOICE_CONFIG_PATH,
    openrouterSttApiKey: raw.OPENROUTER_STT_API_KEY,
  };
}

/**
 * Resolved voice runtime state (VOICE_CONTROLL.md section 6).
 *
 * `disabled`: voice is off; `fixture`: enabled but credential-free and fully
 * offline; `live`: every live prerequisite is present; `incomplete`: voice is
 * enabled in openrouter mode but a required value is missing. Parsing the
 * environment never fails because of voice, so unrelated BFF routes keep
 * working; the server-only voice service maps `incomplete` to a voice-specific
 * 503 (`VOICE_NOT_CONFIGURED`).
 */
export type VoiceRuntimeConfig =
  | { readonly status: "disabled" }
  | { readonly status: "fixture" }
  | { readonly status: "live"; readonly configPath: string; readonly sttApiKey: string }
  | { readonly status: "incomplete"; readonly issues: readonly string[] };

export function resolveVoiceRuntimeConfig(config: ServerConfig): VoiceRuntimeConfig {
  if (!config.voiceEnabled) {
    return { status: "disabled" };
  }
  if (config.aiMode === "fixture") {
    return { status: "fixture" };
  }
  if (config.voiceConfigPath && config.openrouterSttApiKey) {
    return {
      status: "live",
      configPath: config.voiceConfigPath,
      sttApiKey: config.openrouterSttApiKey,
    };
  }
  const issues: string[] = [];
  if (!config.voiceConfigPath) {
    issues.push("VOICE_CONFIG_PATH is required when VOICE_ENABLED=true and AI_MODE=openrouter");
  }
  if (!config.openrouterSttApiKey) {
    issues.push(
      "OPENROUTER_STT_API_KEY is required for live speech-to-text; the shared OPENROUTER_API_KEY is not a substitute",
    );
  }
  return { status: "incomplete", issues };
}
