# ADR-003: Explicit Graph API Instead of Autonomous Agents

Status: accepted for implementation planning; not yet implemented. Date: 2026-10-10.

## Context

The main educational value is observable routing, parallel tasks, fan-in, bounded revision loops, human decisions, and durable re-entry. A supervisor-agent framework would hide those mechanisms and increase nondeterminism/cost.

## Decision

Use TypeScript `StateGraph` with `StateSchema`/Zod, explicit conditional routes, `Send` tasks and a keyed `ReducedValue` channel, and one reusable pure `await_decision` node. Decision kinds distinguish mandatory flight/hotel/approval/confirmation/recovery/clarification steps.

Research domains are hotel, breakfast, lunch, dinner, attractions, and events. Use a new research-run scope when retrying only failed domains; retain successful siblings. Planning has three total attempts; provider work has two; AI adapter owns its two-attempt output/transport retry without graph retry stacking.

Use plain input for a new thread or a new command after `END`, `Command({resume})` with trusted operation envelope for a current dynamic interrupt, and `null` for unfinished recovery. Configure sync durability and a separate 100-superstep recursion guard.

## Alternatives

| Alternative | Reason not chosen |
| --- | --- |
| Prebuilt autonomous agent/supervisor | Unclear domain authority, unnecessary tools/loops/cost |
| Linear function sequence decorated as a graph | Does not demonstrate the required graph behavior |
| Six independent chat agents | Deterministic provider research is sufficient; no conversational coordination needed |
| Static all-domain fan-in barrier | Selective subsets could wait for unscheduled branches |
| Multiple conditionally reordered interrupts in one node | Index-based resume semantics are fragile |

## Consequences

- Each node has one outgoing routing mechanism, not static edges plus competing `Command(goto)`.
- Parallel results are keyed/idempotent and ordering-independent; zero-work dispatch routes directly.
- Side effects occur before/after interruption in separate idempotent nodes, never before `interrupt()` in its replayed node.
- Graph fixtures prove runtime behavior early; actual travel stages grow in later phases without fake-success stubs.

## Verification and References

[Graph design](../03-langgraph-design.md) and its official API references, [Phase05](../phases/phase-05.md), [Phase09](../phases/phase-09.md), [Phase10](../phases/phase-10.md). Verify real-Pg resume/re-entry, task overlap and single join, sibling preservation, recursion/attempt exhaustion, and invalid-itinerary repair.
