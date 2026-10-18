# MCPA2A-012: Legacy trips become read-only history at final cutover

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

Converting graph checkpoints would add risk without a demonstrated need, and
keeping two live runtimes would leave ambiguous ownership.

## Decision

At the Phase 11 cutover, new trips are `coordinator-v1` only. The graph worker
and graph decision bindings are removed; legacy domain records and graph history
remain readable as inert history. No checkpoint conversion is attempted.

## Consequences

- Legacy trips cannot be resumed; they are preserved for audit/history.
- The active runtime has a single owner and claim filter.
- Historical design documents remain for context but are not executable.

## Evidence

`tests/integration/coordinator/cutover.test.ts`,
`scripts/verify-build.mjs`, `docs/planning/migration-results.md`.
