import { describe, expect, it } from "vitest";
import {
  DEMO_REFERENCE_PATTERN,
  canTransitionProposal,
  canTransitionReservation,
  generateDemoReference,
  isDemoReference,
  isProposalActionable,
} from "@odft/domain";

/** T-UT-BOOK-01: reference format/collision resistance and lifecycle transitions. */

describe("demo reference generation", () => {
  it("matches the required format for every service", () => {
    for (const service of ["flights", "hotel", "breakfast", "lunch", "dinner"] as const) {
      const reference = generateDemoReference(service);
      expect(reference, service).toMatch(DEMO_REFERENCE_PATTERN);
      expect(isDemoReference(reference)).toBe(true);
    }
  });

  it("uses the FLT/HTL/RST prefixes", () => {
    expect(generateDemoReference("flights")).toMatch(/^DEMO-FLT-[0-9A-F]{20}$/);
    expect(generateDemoReference("hotel")).toMatch(/^DEMO-HTL-[0-9A-F]{20}$/);
    expect(generateDemoReference("dinner")).toMatch(/^DEMO-RST-[0-9A-F]{20}$/);
  });

  it("is injectable for deterministic collision tests", () => {
    const reference = generateDemoReference("hotel", () => "abcdef0123456789abcd");
    expect(reference).toBe("DEMO-HTL-ABCDEF0123456789ABCD");
  });

  it("rejects a malformed reference", () => {
    expect(isDemoReference("DEMO-FLT-123")).toBe(false);
    expect(isDemoReference("DEMO-XXX-ABCDEF0123456789ABCD")).toBe(false);
  });
});

describe("lifecycle transitions", () => {
  it("allows confirmed -> superseded/cancelled only", () => {
    expect(canTransitionReservation("confirmed", "superseded")).toBe(true);
    expect(canTransitionReservation("confirmed", "cancelled")).toBe(true);
    expect(canTransitionReservation("superseded", "confirmed")).toBe(false);
    expect(canTransitionReservation("cancelled", "superseded")).toBe(false);
  });

  it("treats only proposed proposals as actionable", () => {
    expect(isProposalActionable("proposed")).toBe(true);
    for (const status of ["accepted", "rejected", "expired", "superseded"] as const) {
      expect(isProposalActionable(status), status).toBe(false);
    }
  });

  it("allows proposed to advance to exactly one terminal state", () => {
    expect(canTransitionProposal("proposed", "accepted")).toBe(true);
    expect(canTransitionProposal("accepted", "rejected")).toBe(false);
  });
});
