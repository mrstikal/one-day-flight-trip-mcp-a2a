# ADR-005: Two-stage Flight Feasibility and Bound Approvals

Status: accepted for implementation planning; not yet implemented. Date: 2026-10-10.

## Context

Faker can generate plausible-looking but impractical flights. An actual airport near a city does not justify a flight-based trip, and cached checkpoints can carry an unrelated successful route verdict after an input change.

## Decision

Stage A deterministically evaluates airport/city/catchment/ground practicality and synthetic-route plausibility before generating flight offers. Outcomes are `FEASIBLE`, `INFEASIBLE`, and `UNDETERMINED`. Unknown evidence blocks generation. Short distance is a warning requiring evidence, not universal rejection; explicit island exceptions are supported.

Persist a server-created approval bound to canonical current-input fingerprints including origin, destination, date, variant, party, references/generator/rules, candidate airports, and transfer settings. The flight generator and booking service independently verify this approval against current domain inputs; a restored checkpoint boolean is insufficient.

Stage B independently validates generated UTC/local schedules, duration/connections, arrival/check-in windows, full core sightseeing, late/next-day return, and airport buffers. Selected hotel/meal logistics are validated again. Flight-domain hashes, not unrelated overall snapshot versions, bind Stage B.

## Alternatives

| Alternative | Reason not chosen |
| --- | --- |
| Only airport existence/`scheduled_service` | PRG -> Ceske Budejovice could incorrectly pass |
| Universal minimum-distance rejection | Would reject sensible island air links such as BCN -> PMI |
| LLM feasibility judgment | Cannot be a deterministic business gate |
| Validate only after flight generation/booking | Violates the mandatory sequencing and permits misleading offers |
| Reuse checkpoint `FEASIBLE` after edits | Stale destination/date/origin approval bypass |

## Consequences

- PRG -> Ceske Budejovice is rejected as ground-preferred, not described as unreachable by ground.
- PRG -> Rome/Paris/Barcelona is supported; same catchment and impossible schedule are rejected.
- Missing reference evidence produces a limitation and useful alternatives, not fake data.
- Unavailable one-night late return disables that variant; nullable dinner is allowed only with deterministic no-slot evidence, never by dropping a confirmed meal.
- No hotel research/booking/itinerary progression follows a failed Stage A/B gate.

## Verification and References

[Policy/rules](../05-synthetic-data-design.md#5-stage-a-deterministic-route-feasibility), [domain approvals](../04-domain-model.md#4-two-stage-flight-validation), [full regression suite](../11-testing-strategy.md#9-feasibility-regression-suite-mandatory-addendum-full-list), [Phase04](../phases/phase-04.md). Verify all12 addendum regressions including restart/resume/after-END route changes and generator/booking guards.
