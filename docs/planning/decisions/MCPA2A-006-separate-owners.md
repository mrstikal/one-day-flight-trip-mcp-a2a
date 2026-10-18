# MCPA2A-006: Separate owners for domain tables, cursor, outbox and SDK tasks

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

Two competing copies of trip or task truth would make recovery and replay
ambiguous.

## Decision

- Domain tables own trip state, selections, proposals and reservations.
- `coordinator_runs` owns only the coordinator cursor.
- `agent_delegations` plus `protocol_outbound_messages` own delivery intent and
  binding; the outbox commits before HTTP.
- The official SDK task stores own A2A task/message state.

## Consequences

- Every durable responsibility has exactly one owner.
- Cross-owner links are explicit ids/fingerprints, never copied payloads.
- Replay is idempotent at the owning layer.

## Evidence

`packages/persistence/migrations/*`, `tests/integration/coordinator/recovery.test.ts`,
`tests/integration/protocols/restart.test.ts`.
