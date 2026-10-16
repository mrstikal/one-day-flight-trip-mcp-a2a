import { describe, expect, it } from "vitest";
import { ConfigError, parseServerConfig } from "@odft/persistence";

const BASE_ENV = {
  DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/odft",
  PUBLIC_BASE_URL: "http://localhost:3000",
  SESSION_HMAC_KEY: "a".repeat(48),
};

describe("parseServerConfig", () => {
  it("returns fixture defaults with no OpenRouter credentials", () => {
    const config = parseServerConfig({ ...BASE_ENV });
    expect(config.aiMode).toBe("fixture");
    expect(config.openrouterApiKey).toBeUndefined();
    expect(config.maxPlanningAttempts).toBe(3);
    expect(config.maxProviderAttempts).toBe(2);
    expect(config.maxLlmCallsPerTrip).toBe(40);
    expect(config.maxLlmCostUsdPerTrip).toBe(1.0);
    expect(config.demoControlsEnabled).toBe(false);
    expect(config.workerConcurrency).toBe(2);
  });

  it("rejects a missing required value without echoing secrets", () => {
    const secret = "super-secret-session-key-value-that-must-not-leak";
    const env = { ...BASE_ENV, SESSION_HMAC_KEY: secret, DATABASE_URL: "" };
    let caught: unknown;
    try {
      parseServerConfig(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).not.toContain(secret);
    expect((caught as ConfigError).issues.join(" ")).toContain("DATABASE_URL");
  });

  it("rejects a malformed database URL", () => {
    expect(() => parseServerConfig({ ...BASE_ENV, DATABASE_URL: "mysql://x" })).toThrow(ConfigError);
  });

  it("requires an OpenRouter key in openrouter mode", () => {
    expect(() => parseServerConfig({ ...BASE_ENV, AI_MODE: "openrouter" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("accepts openrouter mode when a key is provided", () => {
    const config = parseServerConfig({
      ...BASE_ENV,
      AI_MODE: "openrouter",
      OPENROUTER_API_KEY: "sk-demo",
    });
    expect(config.aiMode).toBe("openrouter");
  });

  it("rejects an invalid public base URL", () => {
    expect(() => parseServerConfig({ ...BASE_ENV, PUBLIC_BASE_URL: "not-a-url" })).toThrow(
      ConfigError,
    );
  });

  it("parses explicit strings for controls and numeric overrides", () => {
    const config = parseServerConfig({
      ...BASE_ENV,
      DEMO_CONTROLS_ENABLED: "false",
      WORKER_CONCURRENCY: "4",
      MAX_LLM_COST_USD_PER_TRIP: "2.5",
      MAX_PLANNING_ATTEMPTS: "5",
    });
    expect(config.demoControlsEnabled).toBe(false);
    expect(config.workerConcurrency).toBe(4);
    expect(config.maxLlmCostUsdPerTrip).toBe(2.5);
    expect(config.maxPlanningAttempts).toBe(5);
  });

  it("rejects an unknown AI mode", () => {
    expect(() => parseServerConfig({ ...BASE_ENV, AI_MODE: "magic" })).toThrow(ConfigError);
  });

  it("treats an empty numeric override as unset rather than zero", () => {
    const config = parseServerConfig({ ...BASE_ENV, MAX_LLM_COST_USD_PER_TRIP: "" });
    expect(config.maxLlmCostUsdPerTrip).toBe(1.0);
  });

  it("rejects the too-short example placeholder session key", () => {
    expect(() => parseServerConfig({ ...BASE_ENV, SESSION_HMAC_KEY: "replace-me" })).toThrow(
      ConfigError,
    );
  });
});
