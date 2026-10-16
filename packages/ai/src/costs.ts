import { AdapterError } from "./adapter.js";
import type { RoleProfile } from "@odft/contracts";

/**
 * Fixed-precision USD cost arithmetic for call reservations
 * (06-ai-agent-design.md section 8).
 *
 * All amounts are integer BigInt scaled by 1e9 (matching `numeric(18,9)`), never
 * floating point, and always rounded upward. AI USD is kept strictly separate
 * from travel EUR.
 */

const SCALE = 1_000_000_000n;
const MILLION = 1_000_000n;

/** Parse a nonnegative USD decimal string into a 1e9-scaled BigInt. */
export function parseUsd(value: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(value)) {
    throw new AdapterError("AI_PRICING_UNKNOWN", `invalid USD amount: ${value}`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const padded = (fraction + "000000000").slice(0, 9);
  return BigInt(whole) * SCALE + BigInt(padded);
}

/** Format a 1e9-scaled BigInt back to a USD decimal string (trimmed to 9 dp). */
export function formatUsd(value: bigint): string {
  if (value < 0n) {
    throw new AdapterError("AI_PRICING_UNKNOWN", "negative USD amount");
  }
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** Ceiling division of a 1e9-scaled amount by a positive integer divisor. */
function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

export interface CostBounds {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Worst-case reservation for one attempt: input cap at the worst input rate,
 * total output cap at the worst output rate (reasoning tokens included), plus the
 * verified per-request fee. Each component is rounded upward.
 */
export function worstCaseCostUsd(profile: RoleProfile, bounds: CostBounds): bigint {
  const inputRate = parseUsd(profile.inputPriceUsdPerMillion);
  const outputRate = parseUsd(profile.outputPriceUsdPerMillion);
  const requestFee = parseUsd(profile.requestPriceUsd);
  const input = ceilDiv(BigInt(bounds.inputTokens) * inputRate, MILLION);
  const output = ceilDiv(BigInt(bounds.outputTokens) * outputRate, MILLION);
  return input + output + requestFee;
}

export function addUsd(a: bigint, b: bigint): bigint {
  return a + b;
}

export function compareUsd(a: bigint, b: bigint): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Refuse configuration whose worst-case single call exceeds the role ceiling.
 * The operator must change the limit explicitly instead of silently overspending.
 */
export function assertProfileWithinCeiling(profile: RoleProfile): void {
  const worst = worstCaseCostUsd(profile, {
    inputTokens: profile.maxInputTokens,
    outputTokens: profile.maxOutputTokens,
  });
  const ceiling = parseUsd(profile.maxCallCostUsd);
  if (compareUsd(worst, ceiling) > 0) {
    throw new AdapterError(
      "AI_UNSUPPORTED",
      `role profile worst-case cost ${formatUsd(worst)} exceeds its ceiling ${profile.maxCallCostUsd}`,
    );
  }
}
