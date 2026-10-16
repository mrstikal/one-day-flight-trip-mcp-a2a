# Phase 10 - Itinerary Planner, Deterministic Validation, Qualitative Review, Bounded Loop, Timeline/Map/Costs (Scenarios E, F, G)

Status: implementation-phase specification, planning-only; contains no application code.
Authority: `12-implementation-roadmap.md` is the gate authority; contracts are owned by `02`-`11`; this file instructs and never redefines.
Executor: coding agent. Analysis -> implementation -> verification -> STOP before Phase 11.

## 1. Goal

Deliver the complete sightseeing-day pipeline: `plan_itinerary` (planner role or fixture) proposing ordered stops from existing candidate IDs; deterministic assembly resolving UTC times, routes, fixed reservation windows, transfers, and party costs; `validate_itinerary` with the machine-readable error/warning taxonomy; `review_itinerary` (reviewer role or fixture) for qualitative findings only; the bounded plan -> validate -> review -> replan loop (3 total attempts per user operation); immutable draft/approved itinerary versions with the `itinerary_approval` decision; and the timeline, map (responsive with offline fallback), and cost surfaces. Prove scenarios E, F, G.

## 2. Prerequisites

- P01-P09 accepted; all common commands green; `AI_MODE=fixture` default.
- P04: pricing/route helpers, activity duration templates, snapshots/approvals, Stage B core sightseeing rule (destination-local 09:00 through at least 18:00), `RoutingProvider`.
- P07: hotel/meals selected; confirmed meal IDs/times/durations fixed; `program_choices` submitted selections.
- P08: `planner`/`reviewer` roles, prompts, budget/attempt governance; intent clarification stores typed unexecuted `requestedCommands` plus `preserve`.
- P09: ranked candidate refs per domain with input fingerprints.

## 3. Source Inputs (authoritative)

- `03-langgraph-design.md` sections 4, 6, 9: planner/validator/reviewer node contracts, routing table, bounded work.
- `04-domain-model.md` sections 2, 6, 7, 8: dinner contract, commands/requirements, decisions, itinerary and validator contracts.
- `05-synthetic-data-design.md` sections 6, 8, 9, 12: schedule windows, pricing, duration templates, scenarios E/F/G.
- `06-ai-agent-design.md` sections 1, 5, 6: planner/reviewer schemas, prompt requirements.
- `08-frontend-ux.md` sections 5, 7, 9, 11, 13: itinerary step, pace metrics, map policy, accessibility, timeline.
- `11-testing-strategy.md` sections 5, 6.5, 7, 10, 14 (P10 gate).

## 4. Binding Decisions (do not re-decide)

- The planner selects only existing candidate IDs plus ordering/time allocation; free-form events, coordinates, prices, flight offers, or mutable reservation definitions are rejected before feasibility validation. Deterministic assembly resolves UTC times, route estimates, airport events, costs, and fixed reservation locks.
- Assembly inserts transfers only into sufficient gaps and records a conflict when they do not fit; it never compresses an activity or moves a fixed booking. Required activity counts and user-selected IDs are checked against actual resolved tags.
- Invalid itinerary is normal routing, not an exception retry. Validator errors block approval: overlap, opening-hours mismatch, transfer gap, airport buffer, insufficient sightseeing, missing required meal, missing break, excessive walking, incompatible reservation, preference conflict, budget exceeded, unmet `minimumActivityCounts`. Warnings require a visible explanation. The result carries machine-readable errors/warnings, metrics, and a fingerprint.
- The reviewer never overrules a deterministic rejection; it reviews only a deterministically valid draft, once per attempt, returns `acceptable`/`revise`/`conflict` with enums and known event IDs only (max 8 issues), and its suggested order goes back to the planner, not into state as a mutation.
- Bounds: 3 total plan attempts per user operation (not 3 extra retries); the 4th is blocked into a recovery/clarification decision. `recursionLimit: 100` is only a last-resort safety bound. Budget conflicts stop the loop with lower-cost alternatives or a raise-budget clarification; no automatic downgrades or replacements.
- Pace is intensity, never category. Use the authoritative presentation metrics (`08` section 7): target activities 2-3/3-5/5-7; visit-time caps 240/360/480 min; meal duration defaults by pace; walking caps 4/7/10 km; buffers +20/+15/+10 min. Duration templates override raw counts. Confirmed meal durations are fixed and never moved or extended to fit pace.
- `minimumActivityCounts` (tag -> 1..7) are hard planning inputs; relative counts were already converted to absolute values before storage. A pace/time conflict is clarified with practical feasible options (reduce a minimum, change pace, pick shorter available visits), never silently resolved. `null` dinner appears only with the deterministic no-feasible-slot result; a confirmed dinner is never removed.
- Itinerary versions are immutable and append-only; draft and approved are distinguishable; a later modification creates a new draft without mutating the approved version. Approval binds the current relevant fingerprints; restored checkpoints cannot reuse a stale approval, and a `FEASIBLE` route fingerprint plus current inputs are re-verified at generation and booking.
- Map: Leaflet 1.9.4 as a direct dependency in one client-only component (`dynamic(..., { ssr: false })`), plain Leaflet, no wrapper. Tiles only from a policy-compliant source with visible `Copyright OpenStreetMap contributors` attribution and GeoNames/ODbL data credits; normal HTTP caching, no cache-busting, no prefetch/preload of offscreen tiles, no offline tile packs; the tile URL is public and must never contain credentials. If no tile loads within 5 seconds, repeated failures occur, or no URL is configured, render the static SVG schematic labeled `Approximate simulated connections` with a manual fallback action. Every map fact exists as accessible text.
- Costs are deterministic simulated EUR party totals from the persisted snapshot; parties, dates, nights, and variant agree across offers, bookings, and the itinerary. AI USD cost stays separate. Nothing is re-priced from a later mutable preference.
- Accessibility: WCAG 2.2 AA, keyboard-complete timeline/approval dialog/map details, visible unobscured focus (2.4.7/2.4.11; aiming for 2.4.13 AAA is optional and must not be mislabeled), `prefers-reduced-motion`, target size >= 24 px. Styling stays CSS-first Tailwind 4 with `@theme`; no Tailwind JS config.

## 5. Detailed Ordered Steps

1. Implement `plan_itinerary`: build bounded planner context (candidates, fixed windows, pace, requirements, feedback), call the planner role or fixture, validate the strict proposal schema, and persist a proposal under the attempt effect scope. Increment `planningAttempt` exactly once per user operation attempt.
2. Assemble UTC/local events, fixed meals, buffers/transfers and metrics. Apply Phase04 ticket/transport prices and unique inclusion keys; include both flight directions/all nights, exclude null dinner/extras explicitly, and never double-add a booked selected offer.
3. Implement `validate_itinerary` with the taxonomy of section 4 plus metrics and fingerprint; `invalid` returns structured feedback to the planner while attempts remain.
4. Implement `review_itinerary`: only for a deterministically valid draft; persist typed findings; `revise` feedback returns to the planner; `conflict` becomes a blocking clarification; nonblocking suggestions become visible warnings when the bound is reached.
5. Implement the bounded loop wiring: plan -> validate -> (invalid, attempts < 3) plan; -> review -> (revise, attempts < 3) plan; 3rd failure or budget conflict -> recovery/clarification decision with best valid partial information.
6. Implement `itinerary_approval` (`approve_itinerary` decision) and immutable version persistence: draft badge until approval, approved version preserved, new drafts on later changes.
7. Build the itinerary page: chronological timeline in the destination zone, event cards with provenance/lock badges, validation summary anchored to events, approval dialog (disabled while errors exist), draft/approved state, cost breakdown.
8. Build the client-only map component with the section 4 tile policy, the 5-second/empty/failure fallback, marker list equivalents, and responsive behavior at the `08` breakpoints.
9. Implement scenario controls: E (persisted first-attempt overlay introduces one overlap after parsing; validator catches it and replanning repairs it or stops at the bound; label the injected corruption), F (explicit budget overlay below the final feasible cost; no falsified prices; alternatives/raise-budget decision), G (scripted six-major-museums-at-relaxed-pace request yields a clarification preserving the numeric requirement).
10. Emit safe events for attempt start/finish, validator errors/warnings, review outcome, approval, and map fallback; assert dinner, fixed-duration, and requirement-preservation invariants.

## 6. Concrete Target Paths

```text
packages/domain/src/itinerary/{assemble,validate,taxonomy,metrics}.ts
packages/workflow/src/nodes/{plan-itinerary,validate-itinerary,review-itinerary,publish-summary}.ts
packages/ai/src/roles/{planner,reviewer}.ts          # wire actual role calls (fixture/live)
packages/persistence/src/itineraries.ts
packages/persistence/migrations/0010-itinerary.sql  # only required ALTER/index evolution of Phase03 tables
apps/web/src/app/trips/[id]/itinerary/page.tsx
apps/web/src/components/itinerary/{timeline,event-card,validation-summary,approval-dialog,cost-breakdown}.tsx
apps/web/src/components/map/{map-view,map-fallback,marker-list}.tsx
tests/unit/itinerary/{assembly,validator-taxonomy,pace}.test.ts
tests/integration/itinerary/{bounded-loop,approval,faults-efg}.test.ts
tests/e2e/phase-10.spec.ts
```

## 7. Functions and Interfaces to Implement

| Contract | Input -> Output | Required failure behavior |
| --- | --- | --- |
| `planItinerary(ctx)` | bounded candidates + fixed constraints + feedback -> persisted proposal | schema-invalid/invented IDs rejected before validation; one attempt increment |
| `assembleItinerary(proposal, locks)` | proposal + fixed meal/airport windows -> resolved events + metrics + costs | conflicts recorded, never silent compression or moved bookings |
| `validateItinerary(ctx)` | assembled draft + fingerprints -> `{ status, errors, warnings, metrics, fingerprint }` | errors block approval; invalid is normal routing |
| `reviewItinerary(ctx)` | deterministically valid draft -> typed findings/safe revision hints | never changes an invalid status; not called for rejected drafts |
| `approveItinerary(ctx, decision)` | trusted envelope + current fingerprints -> approved immutable version | stale fingerprint/error state -> typed conflict; no mutation of approved versions |
| `MapView` / `MapFallback` | event/marker projection -> interactive map or SVG schematic | 5 s/failure/no URL -> fallback; tiles never block planning |

## 8. Outputs / Deliverables

- Working planner -> assembly -> validator -> reviewer loop with 3-total-attempt bound and recovery/clarification on exhaustion.
- Immutable draft/approved itinerary versions, timeline, responsive map with offline fallback, and deterministic cost breakdown.
- Passive then active scenario evidence: E repaired or bounded, F budget decision without downgrades, G clarification preserving numeric requirements.
- Tests from section 10; run log and checklist report.

## 9. Measurable Acceptance Criteria

- AC-10-1: a complete valid sightseeing day (breakfast, activities, lunch, breaks, dinner or deterministic null, transfers, buffers) respecting variant/return windows, with costs/routes resolved only by deterministic code (T-UT-ITIN-01/02, T-E2E-09).
- AC-10-2: exactly 3 total planning attempts per user operation; the 4th is blocked into a recovery/clarification decision with best valid partial information (T-IT-LIM-01).
- AC-10-3: scenario E: the injected first-attempt overlap is caught, replanning repairs it or stops at the bound; the injected corruption is labeled.
- AC-10-4: scenario F: budget conflict stops the loop, prices are not falsified, alternatives or a raise-budget clarification appear, and no automatic downgrade/replacement occurs.
- AC-10-5: scenario G: six majors at relaxed pace yields a clarification preserving the typed numeric requirement; no silent reduction; feasible options offered.
- AC-10-6: confirmed meal IDs/times/durations survive pace changes; `null` dinner only with the deterministic no-slot reason; approved versions are immutable and distinguishable from drafts.
- AC-10-7: the map renders with attribution when tiles are available and falls back to the labeled SVG schematic when they are not; planning is unaffected; all map facts exist as text.

## 10. Commands and Tests

```text
npm run typecheck
npm run lint
npm run test:unit
TEST_DATABASE_URL=... npm run test:integration
npm run build
npm run test:e2e -- --grep "phase-10"
```

Tests (P10 gate): T-UT-ITIN-01/02; T-IT-LIM-01; T-E2E-09 (E/F/G). Additional mandatory cases from `11` section 6: nullable dinner only with the deterministic no-slot result; fixed meal duration surviving a pace change; explicit numeric requirement retained inside an unexecuted clarification; unrelated snapshot extension preserving flight-domain approvals. Never back-date tests.

## 11. Explicit Out of Scope

- Full invalidation matrix/re-entry hardening, inspector, SSE replay hardening, scenarios H/I/J/K: P11.
- Final regression/security/mobile hardening, restart/concurrency evidence, runbook, live criterion 28: P12.

## 12. Common Mistakes / Traps

- Treating validator `invalid` as an exception retry or catching it to force approval; stacking attempts beyond 3.
- Letting the reviewer overrule deterministic rejection or mutate state directly; reviewing a rejected draft.
- Planner inventing IDs/coordinates/prices, or free time used to hide unmet requirements; silently compressing activities or moving a fixed meal.
- Enforcing raw pace activity counts while ignoring duration templates and travel; changing category eligibility by pace.
- Silent budget downgrades; re-pricing from a later preference instead of persisted terms.
- Mutating an approved itinerary in place; conflating draft and approved badges.
- Map: wrapper libraries, cache-busting, offscreen prefetch, offline tile packs, credentials in the tile URL, or leaving a blank view when tiles fail. Tailwind JS config.
- Mislabeling AAA 2.4.13 as the AA requirement (AA is 2.4.11 focus unobscured).

## 13. Completion Checklist

- [ ] Read instructions/memory; state active invariants before editing.
- [ ] Planner/assembly/validator/reviewer loop implemented with the 3-total-attempt bound and immutable versions.
- [ ] Timeline, map with fallback, and cost breakdown delivered; accessibility rules applied.
- [ ] Scenarios E/F/G demonstrably reproducible with persisted overlays and labels.
- [ ] Section 10 commands/tests executed with captured output; gaps reported honestly.
- [ ] Only phase-scope files changed; no commits; STOP before Phase 11.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase 10 of the AI Travel Planner in this repository (docs/planning/phases/phase-10.md).

Analysis first (no code changes): read AGENTS.md and agent-memory/index.md, then the phase file,
docs/planning/03-langgraph-design.md (sections 4, 6, 9), 04-domain-model.md (sections 2, 6-8),
05-synthetic-data-design.md (sections 6, 8, 9, 12), 06-ai-agent-design.md (sections 1, 5, 6),
08-frontend-ux.md (sections 5, 7, 9, 11, 13) and 11-testing-strategy.md (sections 5, 6.5, 7, 10,
14). Inspect the Phase 04 pricing/routing/snapshots, Phase 07 fixed selections, Phase 08 role
adapters, and Phase 09 ranked candidates. Report the plan, affected paths, and any contract
conflict. Modify nothing in this pass.

Implementation: plan_itinerary (candidate IDs only) -> deterministic assembly (UTC times, routes,
locked reservations, transfers, costs) -> validate_itinerary taxonomy -> review_itinerary
(qualitative only, never overruling rejection) with 3 total plan attempts per user operation and a
recovery/clarification decision on exhaustion; immutable draft/approved itinerary versions and the
itinerary_approval decision; timeline, client-only Leaflet 1.9.4 map (OSM attribution, normal
caching, no prefetch/offline packs, public credential-free URL) with the 5-second/failure SVG
fallback, and deterministic EUR cost breakdown. Binding decisions in phase-10.md section 4 are
mandatory: errors block approval; warnings explained; confirmed meal IDs/times/durations fixed;
null dinner only with the deterministic no-slot result; minimumActivityCounts never silently
dropped; budget conflict never downgrades automatically; approved versions immutable. Prove
scenarios E, F, G with persisted overlays. Do not implement the inspector, full invalidation
matrix, or later-phase features; do not change contracts or add architecture; no commits.

Verify: run typecheck, lint, test:unit, test:integration (TEST_DATABASE_URL), build, and the
phase-10 E2E subset; execute the tests in phase-10.md section 10 and capture exact output; check
AC-10-1..7 and the section 13 checklist.

Report to the user in Czech: files changed, commands/results, acceptance status, incomplete work,
remaining risks, proposed memory updates only. Then STOP. Do not start Phase 11.
```
