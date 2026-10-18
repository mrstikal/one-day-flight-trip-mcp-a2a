> **Historical baseline.** Sections 1-8 are the Phase 01/02 baseline of the retired LangGraph runtime; the `checkpointer:setup` and graph commands there are no longer runnable. Section 9 records the Phase 12 coordinator comparison; full results are in `docs/planning/migration-results.md`.

# Migration baseline (Phase 01)

Controlled, reproducible baseline of the **then-current** LangGraph application
(`travel-graph-v7`, 29 nodes) for the one-day-flight-trip migration. Everything
below was executed on 2026-10-16 against the isolated stack described here; raw
artifacts are preserved under `.cache/` (gitignored) and every failure is kept
and explained.

- Code under measurement: commit `c10912623d3c` (`c10912623d3c08886d1b1b13d28f462407f677c4`).
  The Phase 01 harness changes listed below were uncommitted while the runs
  executed; they do not alter application behavior (see "Harness changes").
- Raw E2E report: `.cache/playwright-baseline-report.json`
- Raw benchmark results: `.cache/benchmarks/langgraph-baseline.json`

## 1. Environment and isolation

| Item                 | Value                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| Node                 | v22.22.2 (`engines` requests >=24; recorded as measured)                                            |
| PostgreSQL           | 17 container on `127.0.0.1:5442`                                                                    |
| Application database | **not touched** (fingerprint verified unchanged, section 6)                                         |
| Isolated target      | `odft_phase01_test` (disposable, created for this baseline, `*_test` guarded)                       |
| Integration database | `odft_test` (`TEST_DATABASE_URL` from `.env`)                                                       |
| AI mode              | `fixture` (no paid calls, no egress to model providers)                                             |
| Wikidata discovery   | forced `false` in the E2E worker and the benchmark worker (offline determinism)                     |
| Web server           | production build (`next start`), one worker (`WORKER_CONCURRENCY=1`), port 3100                     |
| Origin               | `http://localhost:3100/` — derived from `PUBLIC_BASE_URL` everywhere (exact-Origin check preserved) |

Isolated database setup (idempotent, no application database involved):

```bash
# one-time: create the disposable database (name must end in _test)
psql "$DATABASE_URL" -c "CREATE DATABASE odft_phase01_test"
PHASE01_URL="${DATABASE_URL%/*}/odft_phase01_test"
DATABASE_URL="$PHASE01_URL" npm run db:migrate
DATABASE_URL="$PHASE01_URL" npm run reference:load
DATABASE_URL="$PHASE01_URL" npm run checkpointer:setup
```

No reference re-import, no manifest changes, no live worker, no user
application stopped.

## 2. Harness changes (Phase 01 scope)

| File                                         | Change                                                                                                                                   | Why                                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright.config.ts`                       | Browser/API origin and server port derived from `PUBLIC_BASE_URL`; `reuseExistingServer: false`; `PORT` passed to the web server         | The BFF validates the exact Origin; a hardcoded `127.0.0.1:3000` mismatch existed. A live/dev server must never be silently reused for an isolated fixture run.                                                                     |
| `apps/web/package.json`                      | `start` script: `next start` (was `next start -p 3000`)                                                                                  | Next.js honors `PORT`; the test server can bind the configured port. Default behavior (no `PORT`) is unchanged.                                                                                                                     |
| `tests/e2e/_worker.ts`                       | Requires `DATABASE_URL` (fails loudly otherwise), logs the target database name, passes it explicitly; forces `WIKIDATA_DISCOVERY=false` | Spawned fixture workers must share the explicitly selected isolated database; network landmark curation must never run in tests (it stalled operations and made specs time out).                                                    |
| `tests/e2e/voice-control.spec.ts`            | `openRail` waits for the trip's operations to settle and the operation preloader to clear before any typing                              | The app intentionally blocks interaction with an inert full-screen preloader while the initial work runs; `fill` during that window silently loses the draft (root-caused with a temporary probe, section 5). Test-only timing fix. |
| `package.json`                               | Added `benchmark:baseline` script                                                                                                        | Reproducible entry point.                                                                                                                                                                                                           |
| `tests/benchmarks/baseline-cases.ts` (new)   | Fixed cases/inputs, decision policy, `_test` guard, latency math                                                                         | Declarative benchmark definition and pure, unit-tested helpers.                                                                                                                                                                     |
| `tests/benchmarks/travel-baseline.ts` (new)  | Public-API driver + isolated stack management + metrics                                                                                  | The Phase 01 benchmark.                                                                                                                                                                                                             |
| `tests/unit/benchmark-harness.test.ts` (new) | 12 focused tests (guard + result calculation + case definitions)                                                                         | The only new executable harness logic.                                                                                                                                                                                              |

## 3. Required checks (all run, all results recorded)

Commands (run from the repository root; `PHASE01_URL` as above):

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build && npm run verify:build

# isolated E2E (92 discovered tests, serial)
DATABASE_URL="$PHASE01_URL" PUBLIC_BASE_URL="http://localhost:3100/" \
  PLAYWRIGHT_JSON_OUTPUT_NAME=".cache/playwright-baseline-report.json" \
  npx playwright test --reporter=list,json

# benchmark: 6 cases x 5 repetitions + negative route case
DATABASE_URL="$PHASE01_URL" PUBLIC_BASE_URL="http://localhost:3100/" \
  npm run benchmark:baseline -- --output .cache/benchmarks/langgraph-baseline.json
```

| Check                    | Result                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`              | clean                                                                                                                                     |
| `lint`                   | clean                                                                                                                                     |
| `test:unit`              | 60 files, **554/554 pass** (includes the 12 new harness tests)                                                                            |
| `test:integration`       | 47 files, **197/197 pass**, 577.8 s (expected fault-injection warnings only)                                                              |
| `build` + `verify:build` | pass; 5 pre-existing Turbopack "dynamic filesystem access" warnings (`.next` had to be cleaned once after a stale `ENOTEMPTY` rmdir race) |
| Playwright discovery     | **92 tests in 12 spec files** (`npx playwright test --list`)                                                                              |
| Playwright execution     | **85 passed, 6 failed, 1 skipped, 0 flaky**, 973 s                                                                                        |

### E2E failures (all preserved in the raw report)

All six remaining failures are the **pre-existing stale `phase-10.spec.ts`**
spec, documented in `agent-memory/active-context.md` (the spec is stale against
the 2026-10-14 opt-in visits change; 6/8 tests fail deterministically). They
reproduce deterministically in isolated single-spec runs and are assertion
drift against intentionally changed behavior, not application regressions:

| Test (desktop + mobile)                                                    | Failing expectation                                                            | Current behavior                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `renders the validated day, costs, the map fallback, and approves a draft` | expects `[data-event-kind="activity"]`                                         | visits are opt-in (Phase 12); no pins → meals only      |
| `scenario E: the injected overlap is labeled and repaired`                 | expects `simulated-failure-note` to contain "repaired within the bounded loop" | note text changed with the Phase 10 bounded loop        |
| `scenario G: the relaxed six-museums request preserves the typed number`   | expects the "Save program" button without a clarification                      | a museum-3 request legitimately ends in a clarification |

They were left untouched: the plan forbids rewriting existing suites, and the
behavior change was deliberate (Phase 12). They are reported here as
**existing failures, not harness defects**.

The first full run (before the harness fixes below) additionally failed 18
tests; every one was diagnosed and fixed at the harness level:

- **12 voice tests** — `fill` into the composer while the initial operation was
  still running: the app blocks interaction with an inert overlay, focus is
  impossible, and the typed draft silently never reaches React state. Root
  cause proven with a temporary probe spec (`overlay="Preparing your plan..."`,
  `chatInert=true`, `inputValue()=""`). Fixed in `openRail`.
- **2 phase-07 "early return" tests** — the worker inherited
  `WIKIDATA_DISCOVERY=true` from `.env`; the Helsinki landmark lookup stalled
  (network abort), the operation exhausted retries and the spec timed out at
  3.0 min. Fixed by forcing discovery off in the E2E worker (isolated rerun:
  11.6 s / 9.1 s, both pass).
- **2 route-rejection tests** — same discovery stall for České Budějovice
  (HTTP 429 / abort) pushed the INFEASIBLE result past the 30 s test timeout.
  Isolated rerun after the fix: 2.1 s / 2.9 s, both pass.
- **2 phase-11 "unbooked route change" tests** — same class; isolated rerun
  passes (4.1 s both projects).

## 4. Benchmark design

Fixed inputs (recorded in the raw JSON): `Baseline Traveller`, 1 adult,
`standard` service level, `moderate` pace, interests
`{culture: 3, relaxation: 2, entertainment: 1}`, sightseeing date
`2026-12-01`, travel variant `one_night` / `two_nights`. The scenario seed is
not an input of the current system: it is derived from the persisted route
fingerprint; the resolved seed and domain versions are recorded per trial
(six distinct seeds, `generator-v1`, `reference-2026-10-10`).

Decision policy (verbatim in the artifact): first allowed flight offer;
confirm bookings/replacements with the explicit demo disclaimer; first allowed
hotel offer (next one after a recovery reopened the step); server-computed meal
defaults first, then the next meal offer per category after a recovery;
`recovery` answered with the offered option ids (alternating, bounded to 3 per
trial); approve the exact persisted draft. The driver uses only the public BFF
API (session → trip → projection → resume) and never reads checkpoint state to
complete a trip. Between trials only `odft_app.rate_limit_buckets` (test-only
state) is truncated on the disposable database.

## 5. Benchmark results (30/30 trials accounted for)

| Case                       | Completed          | Total p50 / p95       |
| -------------------------- | ------------------ | --------------------- |
| `prg-rome-one-night`       | 5/5                | 5286 ms / 5961 ms     |
| `prg-rome-two-nights`      | 5/5                | 5221 ms / 5728 ms     |
| `prg-paris-one-night`      | **0/5**            | —                     |
| `prg-paris-two-nights`     | **0/5**            | —                     |
| `prg-barcelona-one-night`  | 5/5                | 5107 ms / 5832 ms     |
| `prg-barcelona-two-nights` | 5/5                | 5133 ms / 5777 ms     |
| **Overall**                | **20/30 (66.7 %)** | **5215 ms / 5832 ms** |

Per-step latencies (submission → next decision visible, nearest-rank p50/p95)
are in the artifact; the steady state is ~500–900 ms per step plus ~670 ms
initial planning, with two slower booking commits in the completed trials
(1.4 s and 1.7 s).

**Fixture AI accounting**: 0 paid LLM calls, 0 reserved/actual tokens, 0
reserved/actual/unknown USD in every trial (fixture mode writes no billable
ledger rows). Observed fixture invocations via persisted events: exactly
**1 planner + 1 reviewer** per completed trial. All latency numbers are
**fixture timing** and must never be compared to live-model latency.

**Database activity (per-trial deltas, isolated measurement window)**:
completed trials — transactions 1270–1542 (median 1481), rows inserted
886–1169 (median 1024), rows updated 48–62; failed Paris trials — transactions
2504–2690, rows inserted 1546–1685, rows updated 94–100. Index-scan deltas vary
by an order of magnitude within the final run (≈3.3 k–186 k) because
PostgreSQL flushes per-backend table statistics in bursts, so scan counts are
reported as a coarse signal only; transaction and row-activity deltas
reproduced consistently across repeated runs.
`pg_stat_statements` is **not installed** in the local PostgreSQL 17
container, so per-statement SQL counts are **not claimed**. Scope:
`pg_stat_database` (whole database) and `pg_stat_user_tables` summed over
`odft_app` and `odft_checkpoint`; measurement overhead = the harness's own
metric queries plus projection polling every 150 ms (each poll is a real GET
`/api/trips/[id]`), all included in the counters.

### Paris finding (deterministic, preserved as failures)

All 10 Paris trials fail with `recovery_limit_reached` after ~10 s. The full
recorded sequence is identical every trial: `flight_choice` →
`booking_confirmation` (book) → `hotel_choice` → `booking_confirmation` (book)
→ `recovery` (`change_hotel`) → `hotel_choice` (2nd offer) →
`replacement_confirmation` → `recovery` (`change_meals`) → `program_choices`
(2nd meal offers) → `recovery` → `change_hotel` (3rd offer) →
`replacement_confirmation` → `recovery` → bound reached (13 steps).
Root cause (evidence in the isolated snapshot): the **first allowed Paris
flight arrives at BVA (Beauvais, ~69 km from central Paris)**; the synthetic
airport-transfer estimate (`pathFactor 1.35`, 45 km/h, +20 min access ≈ 144
min) exceeds the 120-minute `validate_selected_logistics` limit for **every**
hotel, and the recovery card only offers hotel/meal changes — neither can
change the arrival airport. The snapshot does contain ORY/CDG arrivals, but
the recorded first-offer policy deliberately does not optimize. This is a real
current-system dead-end for the fixed policy, not a harness defect; a later
flight would likely clear it. The migration comparison must use the same
policy for the numbers to stay comparable.

### Negative route case (AC-06-3)

PRG → České Budějovice (`geonames:3077916`): `routeStatus = INFEASIBLE`,
`routeReasons = [GROUND_TRAVEL_PREFERRED]`, 0 flight offers, 0 scenario
snapshots persisted, 0 reservations, `workflowStatus = blocked` — **PASS**,
proving no flights are generated for the rejected ground route.

### Destructive-target guard exercise

`DATABASE_URL` pointing at the application database `odft` (non-`_test`):

```text
benchmark: Refusing to run the benchmark against non-test database "odft".
Choose a dedicated disposable database whose name ends in _test.
exit code: 1
```

No output artifact was written, no connection was opened and the application
database fingerprint was identical before/after
(`trips=1324`, `rate_limit_buckets=379`, `execution_events=91157`).

## 6. Known warnings and limitations

- The 6 stale `phase-10.spec.ts` failures (section 3) are the only red E2E
  result; everything else is green.
- Paris cannot complete under the recorded policy (section 5) — expected
  baseline value, not a flake.
- Fixture timings are not performance predictions; concurrency is 1/1.
- `pg_stat_statements` unavailable → no SQL statement counts; index-scan deltas
  are additionally noisy due to PostgreSQL's bursty stats flushing (section 5).
- DB counters include measurement overhead and the polling GETs.
- The production build emitted 5 pre-existing Turbopack fs-tracing warnings;
  one build attempt failed on a stale `.next` `ENOTEMPTY` race and succeeded
  after `rm -rf apps/web/.next` (no code change).
- `WIKIDATA_DISCOVERY` is forced off for tests; the dev default in `.env`
  remains `true`.
- The plan's dependency note requests Node 24; this run used the system default Node
  v22.22.2 (Node 24.21.0 is available via nvm at
  `/home/alex/.nvm/versions/node/v24.21.0`; `npm run` does not re-check `engines`).
  This is an accepted deviation of this baseline run, recorded here and visible
  as `environment.node` in the artifact; a Node 24 rerun of the same harness
  (identical commands) is a pending option for the migration comparison.

## 7. Interpretation for the migration

- The current graph completes a standard Rome/Barcelona day trip in ~5.2 s of
  fixture wall-clock with a fully deterministic step sequence and no paid AI
  calls; this is the reference envelope the new system must stay within.
- The Paris BVA transfer dead-end and the recovery-card limitation are
  concrete behaviors the migration must either reproduce deliberately or fix
  — they are now pinned by a reproducible case.
- The E2E suite is green except for the documented stale phase-10 spec; the
  isolated harness (origin from `PUBLIC_BASE_URL`, no server reuse, fixture AI,
  discovery off, `_test`-only data) is reproducible from the commands above.

## 8. Phase 02 post-extraction comparison (2026-10-16)

Phase 02 extracted the worker composition into the SDK-free `@odft/services`
package (worker ports became compatibility adapters; the persistence research
path gained an explicit-snapshot read-only query). The full check set was re-run
against the same isolated stack:

| Check               | Baseline (Phase 01)                    | After Phase 02                           |
| ------------------- | -------------------------------------- | ---------------------------------------- |
| Unit                | 60 files / 554 tests                   | 61 files / 559 tests (new boundary test) |
| Integration         | 47 files / 197 tests, 577.8 s          | 47 files / 197 tests, 564.2 s            |
| E2E (isolated)      | 85 passed / 6 stale / 1 skipped, 973 s | 85 passed / 6 stale / 1 skipped, 969 s   |
| Benchmark           | 20/30, p50 5215 ms                     | 20/30, p50 5228 ms                       |
| Negative route case | PASS                                   | PASS                                     |
| Graph version       | travel-graph-v7, 29 nodes              | unchanged                                |

Raw artifact of the post-extraction benchmark:
`.cache/benchmarks/langgraph-phase02.json` (baseline:
`.cache/benchmarks/langgraph-baseline.json`). Compared programmatically:

- all six scenario seeds are **identical** (route fingerprints unchanged),
- `generator-v1` / `reference-2026-10-10` unchanged,
- **every completed trial's decision-step sequence is identical** (e.g.
  `start->flight_choice->booking_confirmation->hotel_choice->booking_confirmation->program_choices->itinerary_approval->completed`),
- reservations, fixture AI invocation counts (1 planner + 1 reviewer) and the
  zero paid LLM ledger are unchanged.

Conclusion: the extraction is behavior-preserving on every observable axis the
baseline pinned (completion, step transitions, seeds/fingerprints, reservations,
latencies within noise).

## 9. Phase 12 final comparison (2026-10-18)

The final Phase 12 gate re-ran the same six cases × five repetitions against the
coordinator-only runtime, with the complete fixture stack (web, worker, MCP host,
three primary A2A agents) on one disposable `*_test` database. The full results,
gate counts, runtime defects and the 25-condition checklist are in
[migration-results.md](migration-results.md).

| Check                  | Phase 01 graph                       | Phase 12 coordinator                                                          |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Benchmark              | 20/30, p50 5215 ms / p95 5832 ms     | **25/30, p50 4817 ms / p95 5059 ms**                                          |
| `prg-paris-one-night`  | 0/5                                  | 0/5 (same fixed-input infeasibility; explicit bounded clarification/recovery) |
| `prg-paris-two-nights` | 0/5                                  | **5/5**                                                                       |
| Negative route case    | PASS                                 | PASS                                                                          |
| Fixture AI             | 0 paid calls; 1 planner + 1 reviewer | unchanged                                                                     |
| Engine                 | travel-graph-v7                      | `coordinator-v1` (LangGraph removed)                                          |

The completed-trial decision sequence is unchanged
(`flight_choice → booking_confirmation → hotel_choice → booking_confirmation →
program_choices → itinerary_approval → completed`), and the six scenario seeds
remain derived from the same persisted route fingerprints. The coordinator is
faster in fixture mode and completes the Paris two-night case that the graph
rejected; Paris one-night remains deterministic and is reported, not hidden.
