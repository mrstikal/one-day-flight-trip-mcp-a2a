import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chooseInvocation, type CheckpointView, type InvocationOperation } from "@odft/workflow";

/**
 * T-IT-INV decision table (03-langgraph-design.md section 8). Pure selection:
 * start / resume / recover / waiting / reconcile / conflict.
 */

const tripId = randomUUID();

function completedView(operationId?: string): CheckpointView {
  return {
    values: { tripId, ...(operationId ? { operationId } : {}) },
    next: [],
    interrupts: [],
  };
}

function interruptedView(operationId?: string, kind = "clarification"): CheckpointView {
  return {
    values: { tripId, ...(operationId ? { operationId } : {}) },
    next: [],
    interrupts: [{ id: "int-1", value: { kind } }],
  };
}

function unfinishedView(operationId?: string): CheckpointView {
  return {
    values: { tripId, ...(operationId ? { operationId } : {}) },
    next: ["join_research"],
    interrupts: [],
  };
}

function commandOp(id = randomUUID()): InvocationOperation {
  return {
    id,
    tripId,
    kind: "command",
    acceptedRevision: 2,
    payload: { type: "retry_failed_domains" },
  };
}

function decisionOp(id = randomUUID(), decisionId = randomUUID()): InvocationOperation {
  return {
    id,
    tripId,
    kind: "decision",
    acceptedRevision: 1,
    payload: {
      requestId: randomUUID(),
      expectedRevision: 1,
      decisionId,
      response: { action: "choose_option", optionId: "continue" },
    },
  };
}

describe("chooseInvocation", () => {
  it("INV-01: new thread starts from the plain validated input", () => {
    const choice = chooseInvocation(null, commandOp());
    expect(choice.kind).toBe("start");
    if (choice.kind === "start") {
      expect(choice.input.operationKind).toBe("command");
      expect(Array.isArray(choice.input.requiredDomains)).toBe(true);
    }
  });

  it("INV-02: completed thread plus a new command starts again", () => {
    const choice = chooseInvocation(completedView(randomUUID()), commandOp());
    expect(choice.kind).toBe("start");
  });

  it("INV-03: the exact pending decision resumes with the trusted envelope", () => {
    const decisionId = randomUUID();
    const choice = chooseInvocation(interruptedView(randomUUID()), decisionOp(randomUUID(), decisionId), {
      pendingDecisionId: decisionId,
    });
    expect(choice.kind).toBe("resume");
    if (choice.kind === "resume") {
      expect(choice.envelope.decisionId).toBe(decisionId);
      expect(choice.envelope.operationId).toBeTruthy();
    }
  });

  it("INV-06: a stale resume with no matching interrupt is a typed conflict", () => {
    const choice = chooseInvocation(completedView(randomUUID()), decisionOp(randomUUID()));
    expect(choice.kind).toBe("conflict");
  });

  it("INV-06: resume that does not match the current pending decision conflicts", () => {
    const choice = chooseInvocation(interruptedView(randomUUID()), decisionOp(randomUUID(), randomUUID()), {
      pendingDecisionId: randomUUID(),
    });
    expect(choice.kind).toBe("conflict");
  });

  it("restores the waiting projection for the interrupted operation itself", () => {
    const operation = commandOp();
    const choice = chooseInvocation(interruptedView(operation.id), operation);
    expect(choice.kind).toBe("waiting");
  });

  it("B1 regression: a stored resume that cannot answer the current interrupt restores waiting", () => {
    // A single travel-graph run holds two sequential interrupts. After a crash
    // before the driver commits the second wait, the DB still holds the previous
    // decision while the checkpoint is at the next interrupt. Replaying the old
    // `choose_offer` envelope against `booking_confirmation` must NOT resume.
    const operation: InvocationOperation = {
      id: randomUUID(),
      tripId,
      kind: "decision",
      acceptedRevision: 1,
      payload: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: randomUUID(),
        response: { action: "choose_offer", offerId: "offer-1" },
      },
    };
    const choice = chooseInvocation(interruptedView(operation.id, "booking_confirmation"), operation, {
      pendingDecisionId: (operation.payload as { decisionId: string }).decisionId,
    });
    expect(choice.kind).toBe("waiting");
  });

  it("resumes when the stored resume action matches the current interrupt kind", () => {
    const operation = decisionOp();
    const choice = chooseInvocation(interruptedView(operation.id, "clarification"), operation, {
      pendingDecisionId: (operation.payload as { decisionId: string }).decisionId,
    });
    expect(choice.kind).toBe("resume");
  });

  it("rejects a NEW command admitted while an interrupt is pending (never silently swallowed)", () => {
    const choice = chooseInvocation(interruptedView(randomUUID()), commandOp());
    expect(choice.kind).toBe("conflict");
  });

  it("INV-04/07: unfinished tasks recover with a null input (rerun only unfinished work)", () => {
    const operation = commandOp();
    const choice = chooseInvocation(unfinishedView(operation.id), operation);
    expect(choice.kind).toBe("recover");
    if (choice.kind === "recover") {
      expect(choice.input).toBeNull();
    }
  });

  it("a DIFFERENT operation never recovers another operation's unfinished checkpoint", () => {
    // Recovering would replay the stale chatMessage/operationId (and could trigger a
    // paid call for the previous message), so the new operation must start fresh.
    const choice = chooseInvocation(unfinishedView(randomUUID()), commandOp());
    expect(choice.kind).toBe("start");
    if (choice.kind === "start") {
      expect(choice.input).not.toBeNull();
    }
    // A decision operation cannot start fresh: it conflicts instead.
    const decision = chooseInvocation(unfinishedView(randomUUID()), decisionOp());
    expect(decision.kind).toBe("conflict");
  });

  it("INV-08: the completed operation's own decision checkpoint reconciles without re-execution", () => {
    const operation = decisionOp();
    const choice = chooseInvocation(completedView(operation.id), operation);
    expect(choice.kind).toBe("reconcile");
  });
});
