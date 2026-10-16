# ADR-002: Domain Truth, Checkpoints, and Idempotent Effects

Status: accepted for implementation planning; not yet implemented. Date: 2026-10-10.

## Context

Graph checkpoints alone do not provide booking transactions, user concurrency control, or atomicity with application-domain SQL. Interrupts/retries/crashes can rerun a node. Confirmed reservations must survive without duplication or silent replacement.

## Decision

Store authoritative preferences, offers/snapshots, selections, proposals, reservations, itinerary versions, and events in application PostgreSQL tables. Use the official PostgreSQL LangGraph saver for execution cursor/tasks/interrupts. Checkpoints contain compact validated references, not a second mutable booking store.

Admit immutable idempotent commands with request/payload hashes and a monotonically advancing trip revision. Use one trip writer, operation leases/fencing, and a unique effect ledger `(operation, node, scope)`. Booking replacement is a single SQL transaction; checkpoint and domain commits remain separate and are reconciled through replay.

Fence official saver `put`/`putWrites` as well as domain writes. An operation-bound wrapper uses a separate checkpoint-write gate shared with fencing-token rotation, a non-locking ownership read, and a separate saver pool. It delegates official serialization/DDL unchanged.

## Alternatives

| Alternative | Reason not chosen |
| --- | --- |
| Memory checkpointer | Cannot survive a new process |
| All state inside checkpoint JSON | Poor domain constraints, booking idempotency, authorized reads, and queryability |
| "One transaction" claim for independent saver/domain writes | Not true for the official independent pool/API |
| Only domain fencing | A stale process could still write checkpoints after losing its lock connection |
| Distributed event-sourcing platform | Excess infrastructure/complexity for this scope |

## Consequences

- The driver has an explicit crash-window/recovery matrix; no exactly-once node-execution claim.
- Same-operation replay reads stored effects even if a proposal/decision is now resolved.
- A trusted resume envelope changes the current operation identity; old checkpoint operation IDs cannot key new effects.
- SQL status/identity constraints and tests enforce one confirmed reservation/service; terms/history remain immutable except explicit lifecycle transitions.
- Checkpointer schema setup is an explicit migration step, not per-worker startup DDL.

## Verification and References

[Architecture sections6-7](../02-architecture.md#6-command-admission-and-concurrency), [domain](../04-domain-model.md), [recovery](../03-langgraph-design.md#8-invocation-and-recovery-contract), [booking](../09-booking-simulation.md). Tests: duplicate/concurrent confirms, commit-before-checkpoint, accepted-resume-before-checkpoint, fencing of stale saver writes, worker and database restart.
