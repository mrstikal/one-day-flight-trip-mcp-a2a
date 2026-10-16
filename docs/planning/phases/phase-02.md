# Phase 02 - Offline Geographic Reference Data

Status: implementation plan (planning only). No application code, migration, test, or dependency exists on
2026-10-10. Every TypeScript/SQL/CLI block below is a future target for the implementation model, not evidence
of completed work. This phase ships versioned data assets plus read-only lookup services; it ships no synthetic
offers and no UI wizard.

## 1. Goal

Ship versioned offline European reference data and read-only lookup services - countries, cities, airports,
city-airport links/catchments, curated landmarks, and IANA time zones - so later phases can resolve an admitted
origin airport and a destination country/city without any runtime network access. Owns FR-REF-1..6.

## 2. Prerequisites

- Phase 01 complete: npm workspace packages (`@odft/web`, `@odft/worker`, `@odft/contracts`, `@odft/domain`,
  `@odft/data`, `@odft/ai`, `@odft/workflow`, `@odft/persistence`), TypeScript 5.9.3 strict, Zod 4.6.5, `pg` 8
  on PostgreSQL 17, Vitest 5, migration runner with the `odft_app`/`odft_checkpoint` schemas, Docker Compose
  Postgres, and the Phase 01 commands: `npm run typecheck`, `lint`, `test:unit`, `test:integration`, `build`,
  `db:migrate`.
- Local PostgreSQL 17 reachable; `TEST_DATABASE_URL` available for integration tests.
- Touch listed modules plus necessary exports/manifests/lockfile/script wiring; preserve unrelated files,
  phase instructions, memory, and existing ignore rules.

## 3. Source Inputs (authoritative)

- docs/planning/05-synthetic-data-design.md sections 2-4 (sources, licenses, scope, catchments, seed landmarks).
- docs/planning/02-architecture.md sections 3-5 (packages/data layout, dependency boundaries, sources of truth).
- docs/planning/04-domain-model.md section 1 (primitive validation) and section 9 (`reference_*`,
  `reference_manifests`).
- docs/planning/01-functional-requirements.md FR-REF-1..6 and the Phase 02 row of section 7.
- docs/planning/11-testing-strategy.md T-UT-REF-01..06 and the Phase 02 gate (section 14).
- ODFT_BRIEF.md sections 4 and 7.2 (UK/CH/NO/IS/Balkans inclusion; offline datasets; no online geocoding).
- Read the current docs; do not rely on older task comments.

## 4. Binding Decisions (do not re-decide)

- Sources: GeoNames `cities15000.zip` + `countryInfo.txt` (CC BY 4.0), OurAirports `airports.csv`/`countries.csv`/
  `regions.csv` (public domain, voluntary credit), reviewed Wikidata landmark entities (CC0, keep QIDs),
  `geo-tz/all` 8.1.9 at import time only, and a timezone-boundary-builder ODbL asset distributed separately with
  attribution. No Natural Earth at runtime; explicit reviewed island/fixed-link/catchment records instead.
- Admission is manifest-driven; never filter by `continent` alone. Admit EU members plus GB, CH, NO, IS, LI, AL,
  BA, ME, MK, RS, MD, UA, BY, AD, MC, SM, VA, and XK (documented application/source extension). TR/RU only via a
  reviewed European-region allowlist (initial: European-side Istanbul city ref, SVO/DME/VKO, LED, KGD; SAW
  excluded). GE/AM/AZ/KZ and non-European overseas territories excluded. Azores/Madeira/Canary admitted as island
  exceptions. Cyprus included.
- Coverage flag per city is exactly one of `curated_landmarks`, `generic_only`, `insufficient_reference`. PRG is
  only the prepared-demo default origin, never the only supported origin.
- Destination airport resolution: 150 km great-circle radius, at most three suitable airports, simulated transfer
  <= 120 minutes, reviewed `metroCatchmentId` preferred. Same airport and same catchment (including cross-border)
  are stored as rejectable facts; Phase 04 Stage A consumes them.
- Airport IANA zones come only from import-time evidence (`geo-tz` cross-checked with the GeoNames city zone) plus
  a reviewed overrides file with reasons. Unknown/ambiguous/ocean `Etc/GMT` results leave an airport non-selectable
  until reviewed.
- Committed assets are filtered files with manifests; normal startup never downloads. Never bundle `geo-tz` or
  reference dumps into the browser.

## 5. Detailed Ordered Steps

1. Add server-only dependency `geo-tz@8.1.9` to `packages/data`, and `scripts/import-reference.ts` as a streaming
   importer (never load full alternate-name dumps into memory).
2. Create the typed admission manifest (section 4) with the XK extension note and TR/RU allowlist entries.
3. Implement importer subcommands `geonames`, `ourairports`, `zones`, `landmarks`, `manifests`, each writing
   `data/reference/*.ndjson` plus `data/manifests/*.json`.
4. Enforce import gates (reject and report, never silently drop): duplicate conflicting IATA codes, out-of-range
   coordinates, missing country keys, impossible city/airport relationships, invalid zones, closed/heliport/
   seaplane-only origins, non-admitted country keys.
5. Resolve airport zones via `geo-tz`, cross-check the nearest reference-city zone, apply
   `airport-zone-overrides.json`; persist `zoneSource`, `zoneEvidence`, `overrideReason`.
6. Build `city-airports.ndjson`: reviewed `metroCatchmentId`, `cityAirportLinks`, passenger eligibility, transfer
   mode + estimate, island/fixed-link evidence. Seed FCO/CIA, CDG/ORY, PRG, the BCN -> PMI short-island
   exception, and the PRG -> Ceske Budejovice ground-corridor evidence used by Phase 04.
7. Import curated landmarks from reviewed Wikidata entity IDs (seed table 05 section 9; complete to >= 8 verified
   references per curated city) and reviewed safe neighborhood/point anchors.
8. Write migration `0002-reference.sql` adding `reference_countries`, `reference_cities`, `reference_airports`,
   `reference_manifests` in the Phase 01 `odft_app` schema, with check constraints, coverage/eligibility flags,
   coordinates, IANA zone + evidence, and search indexes (normalized search key and/or trigram).
9. Implement an idempotent loader that upserts the committed ndjson and records manifest rows; running it twice
   must not duplicate rows.
10. Implement the read-only lookup services in `packages/data/src/reference/` (section 7). No writes, no network.
11. Export read-only services for future `/api/reference/*` handlers. HTTP wiring waits for Phase05 session/rate-limit infrastructure; do not expose an unauthenticated temporary API now.
12. Add unit tests for admission/search/zones/manifests and an integration test for migration + loader; commit
    manifest and license files.

## 6. Concrete Target Paths

```text
data/reference/country-policy.json
data/reference/countries.ndjson
data/reference/cities.ndjson
data/reference/airports.ndjson
data/reference/city-airports.ndjson
data/reference/landmarks.ndjson
data/reference/airport-zone-overrides.json
data/manifests/{geonames,ourairports,wikidata-landmarks,geo-tz,tz-boundary-odbl}.json
data/manifests/licenses/{geonames-cc-by.txt,odbl-timezone.txt}
scripts/import-reference.ts
packages/data/src/reference/{types,country-policy,search,zones,catchments,landmarks}.ts   # @odft/data
packages/persistence/migrations/0002-reference.sql                                       # odft_app schema
packages/persistence/src/reference/repository.ts                                         # @odft/persistence
package.json, package-lock.json, packages/data/package.json, packages/data/src/index.ts  # script/dependency/export wiring
tests/unit/reference/{admission,search,zones,manifests}.test.ts
tests/integration/reference/loader.test.ts
```

## 7. Functions and Interfaces to Implement

```typescript
type CoverageFlag = "curated_landmarks" | "generic_only" | "insufficient_reference";
interface CountryRef { countryKey: string; name: string; admitted: boolean; islandException?: boolean; }
interface CityRef { id: string; countryKey: string; name: string; lat: number; lon: number; zone: string; coverage: CoverageFlag; }
interface AirportRef { id: string; iata: string; name: string; countryKey: string; lat: number; lon: number; zone: string; eligibleOrigin: boolean; zoneEvidence: string; }
interface CityAirportLink { cityId: string; airportId: string; metroCatchmentId: string; transferMinutes: number; transferMode: "public_transport" | "taxi"; evidenceRefs: string[]; }

searchCountries(q: string, limit: number): Promise<CountryRef[]>;
searchCities(input: { countryKey: string; q: string; cursor?: string; limit: number }): Promise<{ items: CityRef[]; nextCursor?: string; datasetLimitation?: string }>;
searchAirports(input: { q: string; cursor?: string; limit: number; scope: "origin" }): Promise<{ items: AirportRef[]; nextCursor?: string }>;
getCityAirports(cityId: string): Promise<{ links: CityAirportLink[]; limitation?: string }>;
resolveCatchment(airportIds: string[]): Promise<{ metroCatchmentId: string | null; sameCatchment: boolean }>;
getCuratedLandmarks(cityId: string): Promise<{ landmarks: { id: string; name: string; lat: number; lon: number; sourceId: string }[]; coverage: CoverageFlag }>;
```

All functions are read-only, deterministic, server-side, and never geocode online.

## 8. Outputs / Deliverables

- Committed filtered reference ndjson + manifest/license files with URL, retrieval date, SHA-256, source license,
  transform version, record counts, and a rejected-record report.
- Migration `0002-reference.sql` (schema `odft_app`, created in Phase 01) applied by `npm run db:migrate`.
- Idempotent loader and read-only lookup services with the interfaces above.
- Read-only service exports ready for authorized Node.js handlers in Phase05.
- Passing unit + integration tests listed in section 10.

## 9. Measurable Acceptance Criteria

- AC-02-1: `searchCountries` returns only admitted keys; XK present and flagged as an extension.
- AC-02-2: `searchCities` returns a coverage flag on every item and a `datasetLimitation` for an absent small
  town; it never invents a city.
- AC-02-3: `searchAirports` rejects closed/heliport/seaplane/unknown codes; PRG appears without a special-case
  admission rule.
- AC-02-4: `getCityAirports` enforces 150 km / <= 3 airports / transfer <= 120 min and returns a structured
  `limitation` when none; Rome->{FCO,CIA} and Paris->{CDG,ORY} share a `metroCatchmentId`.
- AC-02-5: every admitted origin airport has an IANA zone with non-empty `zoneEvidence`; `Etc/GMT`/ambiguous
  results have `eligibleOrigin = false`.
- AC-02-6: every committed asset has a manifest row with a real recorded SHA-256 and committed license text; a
  test asserts no runtime download path exists.
- AC-02-7: PRG -> Ceske Budejovice ground-corridor evidence and BCN -> PMI island evidence are persisted records.
- AC-02-8: >= 8 verified curated landmarks per curated city with QIDs and in-envelope coordinates.

## 10. Commands and Tests

```text
npm run reference:import -- --source all   # explicit maintenance, never startup
npm run db:migrate
npm run typecheck
npm run lint
npm run test:unit          # T-UT-REF-01..06
npm run test:integration   # migration + idempotent loader
npm run build
```

Add only the tests this phase owns; do not claim later-phase tests. If `geo-tz` is nondeterministic for a
coordinate, record that coordinate and add a reviewed override rather than weakening the gate.

## 11. Explicit Out of Scope

- Synthetic offers, seeds, snapshots, pricing (Phase 04).
- Stage A/B feasibility decision logic (Phase 04); only the evidence/catchment facts are stored here.
- Wizard UI, sessions/cookies, admission and HTTP reference-route wiring (Phases05-06).
- Runtime geocoding, commercial travel APIs, worldwide coverage.
- Booking, LLM, worker, checkpointer.

## 12. Common Mistakes / Traps

- Filtering by `continent` or country centroid instead of the explicit manifest.
- Inventing city names, IATA codes, coordinates, or QIDs, or guessing a Wikidata QID instead of verifying it.
- Committing full upstream dumps or reading every alternate-name file into memory.
- Treating OurAirports `scheduled_service=yes` as route evidence.
- Assuming the `geo-tz` MIT label covers the ODbL polygon data.
- Bundling `geo-tz`/reference dumps into client bundles; hardcoding Prague as the only origin.
- Silently dropping rejected import records instead of reporting them.

## 13. Completion Checklist

- [ ] Admission manifest matches section 4 exactly (EU + listed + TR/RU allowlist + island exceptions + XK note).
- [ ] All assets have manifest + license + real SHA-256 and a rejected-record report.
- [ ] Zones + overrides recorded with evidence; unknown zones block origin eligibility.
- [ ] Catchment/metro links + PRG->CB ground evidence + BCN->PMI island evidence present.
- [ ] >= 8 verified curated landmarks per curated city.
- [ ] Migration + idempotent loader run clean twice.
- [ ] Read-only services implemented; no runtime network; HTTP activation deferred to Phase05.
- [ ] T-UT-REF-01..06 + loader integration test pass; typecheck/lint/build pass.
- [ ] No file outside this phase's paths changed; no commit made.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase02 against the completed Phase01 foundation. Inspect the actual repository; do not recreate
existing scaffolding. Analyze -> implement -> verify, then STOP before Phase03; follow roadmap common rules.

Read first: AGENTS.md, agent-memory/index.md, invariants.md, docs/planning/05-synthetic-data-design.md
(sections 2-4, 9), 02-architecture.md (3-5), 04-domain-model.md (1, 9), 01-functional-requirements.md
FR-REF-1..6, 11-testing-strategy.md T-UT-REF-01..06. Use current docs, not older comments.

Analysis (no code): list the exact import gates, admission manifest, zone-evidence rule, catchment rules, and the
paths you will add. Confirm you will not touch other phases' files.

Implement exactly docs/planning/phases/phase-02.md sections 5-7: data assets + read-only lookup services +
migration + idempotent loader + unit/integration tests. No synthetic offers, no feasibility decisions, no UI.

Verify: npm run db:migrate, npm run typecheck, npm run lint, npm run test:unit, npm run test:integration,
npm run build. Show real output and the manifest/checksum/license evidence. Add only this phase's tests.

Report changed files, AC-02-1..8 results, rejected-record counts, and any unresolved limitation. Then STOP. Do not
start Phase 03.
```
