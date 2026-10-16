/**
 * Persisted failure-injection overlays (05 section 12, FR-DEMO-2).
 *
 * This module is the top-level home of the fault helpers; the SQL and the
 * overlay semantics live in `scenario/faults.ts`, which is also used by the
 * scenario tooling. `recordFaultOutcome` persists per-attempt counters so the
 * injection state survives graph retries and worker restarts.
 */

export {
  loadOverlay,
  recordFaultOutcome,
  upsertFault,
  type FaultOutcomeInput,
  type FaultOutcomeRecord,
  type UpsertFaultInput,
} from "./scenario/faults.js";