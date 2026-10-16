import type { CheckpointView, InvocationOperation } from "./choose-invocation.js";

/**
 * Checkpoint-written-but-unreconciled recovery (02-architecture.md section 7).
 *
 * When a completed checkpoint exists but the operation-completion event is
 * missing, recovery inspects the checkpoint and repairs the read projection and
 * event ledger WITHOUT repeating any domain effect (no second booking).
 */

export interface ReconciliationResult {
  readonly operationId: string;
  readonly summary: string;
  readonly lastOutcome: string | null;
  readonly researchKeys: readonly string[];
}

export function reconcileCompleted(
  checkpoint: CheckpointView | null,
  operation: InvocationOperation,
): ReconciliationResult {
  const values = checkpoint?.values ?? {};
  const research = values.researchResults;
  const researchKeys =
    research && typeof research === "object" && !Array.isArray(research)
      ? Object.keys(research as Record<string, unknown>).sort()
      : [];
  const outcome = typeof values.lastOutcome === "string" ? values.lastOutcome : null;
  return {
    operationId: operation.id,
    summary:
      outcome === "success"
        ? "operation checkpoint is complete; projection reconciled without re-execution"
        : "operation checkpoint is complete but reported no successful outcome",
    lastOutcome: outcome,
    researchKeys,
  };
}
