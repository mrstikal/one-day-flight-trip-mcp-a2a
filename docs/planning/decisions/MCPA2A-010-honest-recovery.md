# MCPA2A-010: Retrieve, resubscribe and reconcile; interrupted computation fails explicitly

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

Task persistence does not imply that an executor's in-memory computation can be
resumed. Pretending otherwise would produce false recovery claims.

## Decision

- A later claim retrieves saved tasks and ingests artifacts idempotently.
- `input_required` is a resting state and survives restarts.
- Startup reconciliation marks interrupted work `AGENT_RESTARTED`; it never
  fabricates completion.
- An owner can retry a terminally failed operation; only the failed scope is
  re-dispatched.

## Consequences

- Recovery is honest and testable, with explicit safe failure codes.
- Interrupted paid work is not silently re-run or double-charged.
- The user sees a retry action instead of a wedged trip.

## Evidence

`tests/integration/protocols/{restart,failure-recovery}.test.ts`,
`tests/integration/coordinator/recovery.test.ts`.
