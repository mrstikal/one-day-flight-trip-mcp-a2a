# Phase 04 - Seeded Scenario Engine, Domain Providers, and Two-Stage Feasibility

Status: implementation plan (planning only). No application code, generator, or test exists on 2026-10-10. All
code blocks are future targets. This phase ships the deterministic synthetic data engine, the two-stage flight
feasibility rules, pricing/date/timezone/routing rules, provider interfaces, and persisted snapshots. It ships no
graph/worker, no LLM, and no UI.

## 1. Goal

Produce reproducible synthetic travel content and reject impractical routes deterministically. Owns FR-DATA-1..8
and FR-FEAS-1..9. Stage A validates route practicality before any flight generation; Stage B independently
validates each generated schedule. All feasibility is deterministic TypeScript, never LLM.

## 2. Prerequisites

- Phase 02 (reference geography, catchments, zone evidence) and Phase 03 (contracts, SQL tables for
  `scenario_snapshots`/`route_validations`/`schedule_validations`, `BookingService`) complete.
- Phase 01 commands available; `TEST_DATABASE_URL` for integration tests.
- Pinned versions: `@faker-js/faker` 10.6.0, `@js-temporal/polyfill` 0.5.1, PostgreSQL 17, Zod 4.6.5.

## 3. Source Inputs (authoritative)

- docs/planning/05-synthetic-data-design.md sections 4-11 (catchments, Stage A/B rules, generator pipeline,
  pricing, safe locations, routing, providers).
- docs/planning/04-domain-model.md sections 4-5, 8 (route/schedule contracts, scenario manifest, offers,
  itinerary validation taxonomy).
- docs/planning/01-functional-requirements.md FR-DATA-1..8, FR-FEAS-1..9; ODFT_BRIEF.md addendum sections 1-8.
- docs/planning/11-testing-strategy.md T-UT-DATA-01..03, T-UT-FEAS-01..03, T-REG-FEAS-01..12, T-INV-10a/b,
  Phase 04 gate.
- Read current docs; older comments are not authoritative.

## 4. Binding Decisions (do not re-decide)

Apply the canonical ordered status/reason table:reviewed PRG/Budejovice ground plus245-minute air lower bound runs before missing destination airports. Every reason is typed; StageB separately caps realized direction door-to-door at600 (T-REG-FEAS-06a), not only StageA estimates.

- `scenarioKey = hash(normalized generation inputs + reference/generator/rule versions)`. Independent per-domain
  streams derive from `hash(seed, scenarioKey, domain, domainVersion)`; use separate Faker instances, never a
  reseeded global singleton. Separate breakfast/lunch/dinner streams. `generatedAt` is metadata excluded from
  payload-content comparison.
- Stage A policy `route-policy-v1` (all deterministic):
  same airport/catchment -> `INFEASIBLE: SAME_AIRPORT/SAME_CATCHMENT`; unknown city/airport/zone/missing evidence
  -> `UNDETERMINED`; < 350 km great-circle airport-pair -> warning requiring reviewed ground comparison or an
  explicit geographic exception; ground-preferred rule (reviewed connected-ground corridor, ground <= 300 min,
  estimated air door-to-door >= ground + 45 min) -> `INFEASIBLE: GROUND_TRAVEL_PREFERRED`; standard synthetic
  direct eligibility 350..3500 km, both large eligible airports, different catchments; at most one connection per
  direction with 75..240 minute connections; maximum estimated air door-to-door 600 min per direction.
- The route fingerprint binds: schema/rule/generator versions, reference snapshot version, origin airport,
  destination country/city, candidate destination airports/catchments, sightseeing date, travel variant, party
  size, transfer configuration, and route-policy version. Any change to a bound input forces fresh Stage A, even
  if the outcome would be identical. `FEASIBLE` is a persisted server approval, never a graph boolean.
- The schedule (Stage B) fingerprint binds ONLY the stable scenario key, the flight-domain version/hash, the
  schedule-rule version, and the combination content. NEVER bind Stage B to the whole snapshot version: extending
  dinner inventory must not invalidate flights. Stage B validates outbound/return dates, arrival too late, return
  too early, connection bounds, duration plausibility, timezone/DST validity, transfer buffers, and sufficient
  sightseeing (09:00..18:00 core).
- Separate content hashes per domain and per meal; a dinner extension must not change flight/hotel/breakfast/lunch
  hashes. Offer IDs derive from stable scenario/domain/index content, not random per-read UUIDs.
- Initial snapshots are flight-only. StageB failure never materializes downstream inventories. After confirmed valid flights, dispatch calls idempotent `ScenarioService.ensureDomains` once before Send; track materialized domains/versions, not competing provider extensions.
- Flight duration per direct leg is `ceil(25 + distanceKm / 700 * 60)` minutes, min 35, plus seeded variation
  within +/- 8 minutes; UTC instants plus IANA display zones; overnight transitions and DST gap/fold handled with
  `@js-temporal/polyfill`. Duration is elapsed time, not subtraction of local clocks.
- Pricing (simulated EUR minor units, party totals, single rounding boundary): flights per-adult one-way base
  `25 + 0.085 * km`, season/tier/demand factors (a bounded seeded per-direction factor 0.85..1.20 plus a
  departure-bank factor 1.10/0.90/1.00, so one pair's combinations never share a price), clamp 45..420, +25 per
  connection; hotels Budget 60..95, Standard
  110..180, Luxury 250..420 per room-night times city/season/weekend/nights/rooms; restaurants per the meal/level
  table in 05 section 8 with a documented cuisine factor 0.90..1.15. Budget < Standard < Luxury must be
  meaningful and non-random.
- Faker supplies only fictional labels and controlled variation; domain algorithms own schedules, prices,
  coordinates, dates, capacity. Faker methods depending on the current clock are passed an explicit reference
  date.
- Dinner is `null` only when deterministic selected-flight/logistics assessment finds no feasible dinner slot,
  with a visible reason; a confirmed dinner is never removed this way and meal bookings are fixed. Normal curated
  fixtures include dinner.
- Curated cities: Rome/Paris/Barcelona plus a generic Lisbon sample; PRG -> Ceske Budejovice rejected; BCN -> PMI
  short island allowed only through the explicit catalog entry, never on distance alone. Unknown island/mountain/
  fixed-link cases are `UNDETERMINED` under the conservative policy.
- Both the generator and `BookingService` independently re-read the approval and compare its fingerprint with
  current domain inputs; stale/foreign/mismatched approvals are rejected. No checkpoint-only approval.

## 5. Detailed Ordered Steps

1. Implement seed utilities: `buildScenarioKey`, `deriveDomainSeed`, per-domain Faker instances, and stable
   offer-ID derivation from scenario/domain/index content.
2. Implement `validateRoute(input: RouteInputs): RouteValidation` (Stage A, pure) with the rule table and typed
   `RouteReason` codes, alternatives, evidence refs, and `policyVersion`.
3. Implement `isApprovalCurrent(approval, currentInputs)` and the generator/booking guards that reject stale
   approvals.
4. Implement `generateFlights(approval)` reading only a fresh `FeasibleRouteApproval`; produce outbound/return
   legs, connections, per-adult and party-total prices, supported variant, and stable IDs.
5. Implement `validateSchedules(input): ScheduleValidation` (Stage B, pure) with typed `ScheduleReason` codes and
   `validCombinationIds`; it never repairs invalid data.
6. Implement hotel, restaurant (per meal), activity, and event generators with pricing/season/weekend/night
   factors, safe anchors/envelopes, provenance labels, and the curated landmark/duration templates.
7. Implement `RoutingProvider.estimate` with haversine and per-mode assumptions (05 section 10), returning
   `simulated: true` and `uncertainty`; never a road polyline.
8. Implement snapshot persistence: `persistSnapshot`, `extendSnapshot` (append-only version preserving prior
   offer IDs/hashes), and `computeDomainHashes` including separate breakfast/lunch/dinner digests. Cap a snapshot
   at 1 MiB; store refs in checkpoints, not inventories. Implement staged materialization/ensureDomains; unmaterialized version0 is not provider-unavailable.
9. Implement provider interfaces (`FlightSearchProvider`, `AccommodationSearchProvider`,
   `RestaurantSearchProvider`, `AttractionsProvider`, `EventsProvider`, `RoutingProvider`) and their
   `Synthetic*` implementations returning tagged results (`ok`/`unavailable`/`retryable_error`/`unsupported`).
10. Add failure-injection overlays that change provider/validator behavior without regenerating inventory
    (schema in Phase 03; behavior used by later phases) and persist injection counters.
11. Write the tests in section 10, including the feasibility regression suite at the unit/gating level.

## 6. Concrete Target Paths

```text
packages/data/src/synthetic/{seed,scenario-key,flights,hotels,meals,activities,events,pricing,ids}.ts   # @odft/data
packages/data/src/feasibility/{route-stage-a,schedule-stage-b,fingerprints,approval-guard}.ts
packages/data/src/routing/haversine.ts
packages/data/src/providers/{flight,accommodation,restaurant,attractions,events,routing}.ts
packages/data/src/synthetic/snapshot.ts
packages/persistence/src/scenario/{snapshots,validations}.ts                                            # @odft/persistence
packages/{data,domain,persistence}/src/index.ts, package-lock.json  # approved dependency/export wiring
tests/unit/data/{determinism,pricing,location-provenance}.test.ts
tests/unit/feasibility/{stage-a,stage-b,fingerprint}.test.ts
tests/integration/feasibility/{regression,gating}.test.ts
tests/fixtures/scenarios/{rome,paris,barcelona,lisbon,prg-ceske-budejovice,bcn-pmi}.ts
```

## 7. Functions and Interfaces to Implement

```typescript
buildScenarioKey(inputs: GenerationInputs): string;
deriveDomainSeed(seed: string, scenarioKey: string, domain: Domain, domainVersion: string): string;

validateRoute(input: RouteInputs): Promise<RouteValidation>;
isApprovalCurrent(approval: FeasibleRouteApproval, current: RouteInputs): boolean;
generateFlights(approval: FeasibleRouteApproval): Promise<FlightCombination[]>;
validateSchedules(input: { approval: FeasibleRouteApproval; combinations: FlightCombination[]; scheduleRuleVersion: string }): ScheduleValidation;

generateHotels(input: HotelGenInput): HotelOffer[];
generateMeals(input: MealGenInput): RestaurantOffer[];          // per meal, independent stream
generateActivities(input: ActivityGenInput): ActivityRef[];
generateEvents(input: EventGenInput): EventRef[];

priceFlightPerAdult(distanceKm: number, factors: SeasonFactors, connections: number): number;
priceHotelPerNight(level: ServiceLevel, cityFactor: number, weekend: boolean, season: number): number;
priceMeal(meal: Meal, level: ServiceLevel, cityFactor: number, cuisineFactor: number): number;

RoutingProvider.estimate(input: RouteEstimateInput): RouteEstimate; // time/distance/uncertainty + party EUR cost, simulated:true

persistSnapshot(input: SnapshotInput): Promise<ScenarioManifest>;
extendSnapshot(input: ExtensionInput): Promise<ScenarioManifest>;    // append-only, preserve prior IDs/hashes
ScenarioService.ensureDomains(input: ValidatedScenarioContext, domains: ScenarioDomain[]): Promise<ScenarioManifest>;
computeDomainHashes(snapshot: SnapshotContent): Record<"flights" | "hotels" | "breakfast" | "lunch" | "dinner" | "activities" | "events", string>;
```

## 8. Outputs / Deliverables

- Deterministic seed/scenario utilities and stable offer IDs.
- Stage A and Stage B validators with typed reason codes and current-input fingerprints.
- Flight/hotel/meal/activity/event generators, pricing functions, and the routing provider.
- Provider interfaces plus `Synthetic*` implementations.
- Persisted snapshots with per-domain and per-meal content hashes and extension versioning.
- Unit + integration tests including the feasibility regression suite (validator/gating level).

## 9. Measurable Acceptance Criteria

- AC-04-1: identical seed/key/versions produce identical domain content hashes; separate streams per domain and
  per meal; `generatedAt` excluded; extension preserves prior IDs/hashes.
- AC-04-2: hotel-only extension preserves flights; dinner extension changes only its meal hash. Materialization is one persisted extension before Send; StageB failure blocks downstream domains.
- AC-04-3: PRG -> Ceske Budejovice is `INFEASIBLE: GROUND_TRAVEL_PREFERRED` and produces no flight offers.
- AC-04-4: PRG -> Rome/Paris/Barcelona permitted by the curated policy; BCN -> PMI admitted via the explicit
  catalog, not on distance alone.
- AC-04-5: same airport and same catchment (including the cross-border fixture) -> `INFEASIBLE`.
- AC-04-6: unknown island/mountain/fixed-link route -> `UNDETERMINED`; `UNDETERMINED` never authorizes
  generation.
- AC-04-7: Stage A `FEASIBLE` can still yield Stage B `NO_VALID_OFFERS` with typed reasons (no fabricated repair).
- AC-04-8: impossible connection, too-late arrival, too-early return, and duration/timezone violations are
  rejected with the matching `ScheduleReason`.
- AC-04-9: `generateFlights` and `BookingService.confirm` both reject a stale/mismatched approval after a
  route-input change (T-INV-10a/b).
- AC-04-10: a route rejection produces no offer, selection, or reservation rows anywhere.

## 10. Commands and Tests

```text
npm run db:migrate
npm run typecheck
npm run lint
npm run test:unit          # T-UT-DATA-01..03, T-UT-FEAS-01..03
npm run test:integration   # T-REG-FEAS-01..09 + independent guard forms of 10..12, T-INV-10a/b
npm run build
```

Graph/resume forms of T-REG-FEAS-10..12 and the full worker restart variant wait for Phases 05/06/11/12 and are
not claimed here. Add only the tests this phase owns.

## 11. Explicit Out of Scope

- Graph, worker, checkpointer, interrupts, resume (Phase 05).
- Wizard UI and booking dialogs (Phases 06-07).
- LLM roles, adapter, fixture/live intent (Phase 08).
- Parallel research orchestration (Phase 09); itinerary planner/reviewer loops (Phase 10).
- Real providers, geocoding, routing APIs.

## 12. Common Mistakes / Traps

- Binding the Stage B hash to the whole snapshot version (dinner extension then invalidates flights).
- Reseeding a shared global Faker singleton during parallel domain work.
- Using server-local `Date` arithmetic for nights/instants instead of UTC instants + Temporal.
- Treating straight-line distance as road distance, or returning a navigation polyline.
- Random per-offer prices instead of the documented factors, or collapsing Budget/Standard/Luxury separation.
- Rejecting a route on distance alone, or accepting an unknown island/mountain case by guessing.
- Letting an LLM or a cached boolean decide feasibility; approvals must be re-checked against current inputs.
- Generating flights before a fresh Stage A approval, or repairing an invalid schedule instead of reporting it.
- Regenerating an inventory when a preference changes instead of filtering existing content.

## 13. Completion Checklist

- [ ] Seed/scenario utilities deterministic; independent per-domain and per-meal streams.
- [ ] Stage A rule table + reason codes + fingerprints implemented and unit-tested.
- [ ] Stage B independent validator with typed reasons and no repair.
- [ ] Generators + pricing + routing implemented; provenance labels present.
- [ ] Snapshot persistence + extension + per-domain hashes; dinner extension preserves flight hash.
- [ ] Provider interfaces + `Synthetic*` implementations returning tagged results.
- [ ] T-UT-DATA-01..03, T-UT-FEAS-01..03, T-REG-FEAS-01..09 + guard forms, T-INV-10a/b pass.
- [ ] No file outside this phase's paths; no commit made.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase04 against completed Phases01-03. Reuse contracts/persistence/booking; do not recreate them.
Analyze -> implement -> verify, then STOP before Phase05; follow roadmap common rules.

Read first: AGENTS.md, agent-memory/index.md, invariants.md, docs/planning/05-synthetic-data-design.md (4-11),
04-domain-model.md (4-5, 8), 01-functional-requirements.md FR-DATA-1..8/FR-FEAS-1..9, ODFT_BRIEF.md addendum,
11-testing-strategy.md T-UT-DATA/FEAS and T-REG-FEAS. Use current docs.

Analysis (no code): list the Stage A rule table, the exact route fingerprint inputs, the Stage B hash inputs
(flight-domain only), the per-domain/per-meal hash plan, and the pricing formulas. Confirm no plan to bind Stage B
to the whole snapshot version.

Implement exactly docs/planning/phases/phase-04.md sections 5-7: seeds/scenarioKey, Stage A, generator guard,
flight generator, Stage B, hotel/meal/activity/event generators, pricing, routing, snapshot persistence, provider
interfaces, and the feasibility regression tests. No graph/worker, no LLM, no UI.

Verify: npm run db:migrate, npm run typecheck, npm run lint, npm run test:unit, npm run test:integration,
npm run build. Show real output, including the determinism hashes and the Stage A/B reason codes.

Report changed files, AC-04-1..10 results, and any unresolved limitation. Then STOP. Do not start Phase 05.
```
