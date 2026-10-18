# MCPA2A-011: Independent Accommodation B selected through registry and cards

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

The demo must prove that a specialist can be replaced without coordinator or UI
source changes, not merely renamed around the same executor.

## Decision

`apps/accommodation-agent-alt` is a separate application with its own card,
endpoint, task table, model profile and value-score strategy. It shares only
public contracts, SDK plumbing, deterministic read services and governed AI
wiring. The trusted registry selects A or B for new work.

## Consequences

- Already-bound tasks keep their persisted endpoint/task id.
- The coordinator, UI and artifact ingestion are unchanged by the switch.
- Both implementations must satisfy the same continuation and artifact tests.

## Evidence

`tests/integration/a2a/accommodation-alt.test.ts`,
`tests/integration/protocols/agent-replacement.test.ts`,
`tests/e2e/agent-replacement.spec.ts`.
