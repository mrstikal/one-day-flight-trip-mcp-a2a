import { describe, expect, it } from "vitest";
import type { RoleProfile } from "@odft/contracts";
import { compareUsd, formatUsd, parseUsd, worstCaseCostUsd } from "@odft/ai";

/** USD cost math is integer BigInt scaled by 1e9 and always rounded upward. */

function profile(overrides: Partial<RoleProfile> = {}): RoleProfile {
  return {
    provider: "openrouter",
    model: "openai/gpt-demo",
    timeoutMs: 20_000,
    maxInputTokens: 6_000,
    maxOutputTokens: 1_024,
    maxAttempts: 2,
    maxCallCostUsd: "1",
    inputPriceUsdPerMillion: "1.5",
    outputPriceUsdPerMillion: "2.25",
    requestPriceUsd: "0.0001",
    pricingVersion: "v1",
    allowedEndpointProviderIds: ["openai"],
    ...overrides,
  };
}

describe("AI cost arithmetic", () => {
  it("round-trips USD decimal strings at 9 decimal places", () => {
    expect(formatUsd(parseUsd("1.5"))).toBe("1.5");
    expect(formatUsd(parseUsd("0.000000001"))).toBe("0.000000001");
    expect(compareUsd(parseUsd("0.05"), parseUsd("0.5"))).toBeLessThan(0);
  });

  it("computes a worst-case reservation rounded upward per component", () => {
    // 6000 * 1.5/1e6 = 0.009 ; 1024 * 2.25/1e6 = 0.002304 ; + 0.0001 fee
    const cost = worstCaseCostUsd(profile(), { inputTokens: 6_000, outputTokens: 1_024 });
    expect(formatUsd(cost)).toBe("0.011404");
  });

  it("never under-estimates a fractional rate", () => {
    const cost = worstCaseCostUsd(
      profile({
        inputPriceUsdPerMillion: "0.000000001",
        outputPriceUsdPerMillion: "0",
        requestPriceUsd: "0",
      }),
      { inputTokens: 1, outputTokens: 0 },
    );
    expect(compareUsd(cost, 0n)).toBeGreaterThan(0);
  });

  it("rejects malformed amounts instead of guessing", () => {
    expect(() => parseUsd("abc")).toThrow();
    expect(() => parseUsd("-1")).toThrow();
    expect(() => parseUsd("1.0000000001")).toThrow();
  });
});
