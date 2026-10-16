# ADR-007: Independent Preferences and Selective State Preservation

Status: accepted for implementation planning; not yet implemented. Date: 2026-10-10.

## Context

Global quality, local service level, activity pace, interests, selected offers, and confirmed bookings are different concepts. A simple "re-run everything" response to each chat message would silently replace confirmed services and increase cost.

## Decision

Effective service level is `override[service] ?? default`; each meal has its own override. Pace is independent of culture/relaxation/entertainment and explicit tag/count requirements. Preserve numeric minimums as typed state or unexecuted clarification requests, not only prose.

Preference changes update relevant filtering/recommendations, never bookings. Relative cheaper searches preserve the selected category unless explicitly changed. Selection replacements require a before/after proposal and explicit confirmation; route changes require explicit incompatible-reservation impact approval.

Use the [invalidation matrix](../03-langgraph-design.md#10-selective-invalidation-matrix) and relevant-input hashes to dispatch only affected research. Pace/count changes rebuild program structure while fixed flights/hotel/confirmed meals retain IDs, terms, times, and durations. Draft/approved itinerary versions are distinct.

## Alternatives

| Alternative | Reason not chosen |
| --- | --- |
| Global level mutates all selections | Breaks confirmed-state preservation and local overrides |
| Dinner shares one meal-level preference | Cannot perform dinner-only changes without touching breakfast/lunch |
| Relaxed means only parks | Confuses category with intensity and violates the requested semantics |
| Rebuild every domain after chat | Expensive, nondeterministic, and overwrites unrelated user choices |
| Automatically downgrade to satisfy budget | Requires explicit user consent and can violate same-category requests |

## Consequences

- UI must show inherited/overridden target level separately from currently booked level.
- A same-category cheaper hotel proposal can intentionally differ from a newly changed global default.
- Logistics may need revalidation even when service selection IDs stay fixed.
- When requirements conflict, ask a concrete bounded clarification; do not silently drop constraints or offer unsupported multi-day work.
- New requests after `END` use plain input on the same thread; pending decisions use the trusted resume envelope.

## Verification and References

[Preferences](../04-domain-model.md#2-enumerations-and-preferences), [conversation](../07-conversation-and-intents.md), [UI](../08-frontend-ux.md), [Phase11](../phases/phase-11.md). Tests assert unchanged unrelated IDs/hashes for hotel/dinner/pace, local inheritance, numeric requirements, and budget/preservation conflicts.
