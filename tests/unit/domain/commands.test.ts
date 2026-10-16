import { describe, expect, it } from "vitest";
import type { DomainCommand } from "@odft/contracts";
import { DomainError, validateCommandBatch } from "@odft/domain";

/** Command semantic checks: duplicate/conflicting fields, preserve conflicts. */

function expectDomainError(fn: () => void, code: string): void {
  try {
    fn();
    throw new Error("expected a DomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("validateCommandBatch", () => {
  it("accepts a compatible batch", () => {
    const commands: DomainCommand[] = [
      { type: "set_default_service_level", level: "luxury" },
      { type: "set_activity_pace", pace: "relaxed" },
    ];
    expect(() => validateCommandBatch(commands)).not.toThrow();
  });

  it("rejects duplicate/conflicting writes to the same field", () => {
    const commands: DomainCommand[] = [
      { type: "set_default_service_level", level: "luxury" },
      { type: "set_default_service_level", level: "budget" },
    ];
    expectDomainError(() => validateCommandBatch(commands), "VALIDATION_FAILED");
  });

  it("rejects a command that conflicts with a preserved scope", () => {
    const commands: DomainCommand[] = [{ type: "set_service_override", service: "hotel", level: "budget" }];
    expectDomainError(() => validateCommandBatch(commands, ["hotel"]), "CONFLICT");
  });

  it("rejects set_route that changes nothing", () => {
    expectDomainError(() => validateCommandBatch([{ type: "set_route" }]), "VALIDATION_FAILED");
  });

  it("accepts set_route that changes a field", () => {
    expect(() =>
      validateCommandBatch([{ type: "set_route", travelVariant: "one_night" }]),
    ).not.toThrow();
  });

  it("rejects more than four commands", () => {
    const commands: DomainCommand[] = Array.from({ length: 5 }, () => ({ type: "build_itinerary" }));
    expectDomainError(() => validateCommandBatch(commands), "VALIDATION_FAILED");
  });
});
