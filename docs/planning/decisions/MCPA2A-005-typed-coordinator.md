# MCPA2A-005: Typed application coordinator on the existing queue and fencing

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

The graph runtime must be replaced without introducing a general-purpose
workflow framework or duplicating application rules.

## Decision

Implement an explicit, typed state machine in
`packages/workflow/src/coordinator/*` with `continue`/`wait`/`complete`/`fail`/
`abandon` transitions, a bounded per-claim transition budget, and the existing
operation queue, leases and fencing tokens.

## Consequences

- The cursor is a small typed row, not an opaque graph checkpoint.
- New steps are code changes with tests, not configuration.
- Business rules remain in the existing domain/services packages.

## Evidence

`docs/architecture/coordinator.md`, `tests/integration/coordinator/*`.
