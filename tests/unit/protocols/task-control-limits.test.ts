import { describe, expect, it } from "vitest";
import { assertAllowance, limitsForSkill, TaskLimitError } from "@odft/protocols";

/**
 * Phase 06 cumulative caps: the allowance arithmetic refuses work BEFORE it is
 * done, including the two specialist skills' documented limits.
 */
describe("task allowance caps", () => {
  it("documents the specialist limits of the plan's §3.9 table", () => {
    expect(limitsForSkill("accommodation.recommend.v1")).toMatchObject({
      activeTimeMs: 60_000,
      mcpInvocations: 4,
      llmAttempts: 2,
      maxInputs: 2,
    });
    expect(limitsForSkill("city-guide.research.v1")).toMatchObject({
      activeTimeMs: 90_000,
      mcpInvocations: 8,
      llmAttempts: 2,
      maxInputs: 2,
    });
  });

  const state = {
    control: {} as never,
    limits: limitsForSkill("accommodation.recommend.v1"),
    spentUsd: 0,
    remainingUsd: 0.1,
    remainingActiveMs: 1000,
    remainingMcp: 1,
    remainingLlm: 1,
    remainingInputs: 0,
  };

  it("refuses an exhausted MCP invocation allowance", () => {
    expect(() => assertAllowance({ ...state, remainingMcp: 0 }, { mcpInvocation: true })).toThrow(TaskLimitError);
  });

  it("refuses an exhausted input-request allowance", () => {
    expect(() => assertAllowance(state, { input: true })).toThrow(TaskLimitError);
  });

  it("refuses an exhausted active-time allowance", () => {
    expect(() =>
      assertAllowance({ ...state, remainingActiveMs: 0 }, { activeTime: true }),
    ).toThrow(TaskLimitError);
  });

  it("allows the requested work while the allowance lasts", () => {
    expect(() =>
      assertAllowance(state, { mcpInvocation: true, llmAttempt: true, activeTime: true }),
    ).not.toThrow();
  });
});
