# Phase 12 - Hardening, Full Regression, Restart/Concurrency Evidence, A-N Runbook, Operator README, and Live-AI Acceptance Status

Status: implementation-phase specification, planning-only; contains no application code.
Authority: `12-implementation-roadmap.md` is the gate authority; contracts are owned by `02`-`11`; this file instructs and never redefines.
Executor: coding agent. Analysis -> implementation -> verification -> final report. This is the last phase; do not start anything after it.

## 1. Goal

Close the proof of concept with honest evidence: run the complete unit/integration/E2E/invariant/fault suites and the production build; execute the mandatory feasibility regressions including the worker-restart variant; prove concurrency M/N with two real database connections; harden security, accessibility, and the responsive map fallback; verify import licenses/attribution; prove checkpoint/worker and PostgreSQL restart recovery with real OS processes; make scenarios A-N reproducible from persisted seeds/fault overlays via an operator demo runbook; deliver the operator README; and report the credential-gated live-AI smoke as passed when configured or explicitly `UNVERIFIED` (criterion 28) when credentials are missing.

## 2. Prerequisites

- P01-P11 accepted; all common commands green; `AI_MODE=fixture` default.
- P05: worker claim/lease/fencing, fenced saver, heartbeat, graceful shutdown; restart tests exist.
- P09/P10: fault overlays, scenario modes A-G; P11: inspector, SSE, preservation.
- Test environment: disposable PostgreSQL 17, Playwright browsers, one integration/E2E worker; two extra raw connections available for M/N.

## 3. Source Inputs (authoritative)

- `11-testing-strategy.md` sections 7, 8, 9, 10, 11, 12, 14 (P12 gate): full test IDs and evidence rules.
- `10-security-reliability.md` sections 2-12: cookies/CSRF/ownership/rate limits, LLM safety, secrets, inspector redaction, degraded modes, retention, acceptance evidence.
- `05-synthetic-data-design.md` sections 2, 12: license/manifest obligations, scenario controls A-N.
- `08-frontend-ux.md` sections 9, 11, 12, 15: map policy/fallback, accessibility, responsive rules, acceptance hooks.
- `03-langgraph-design.md` section 8; `02-architecture.md` sections 6, 7, 10: recovery contract, local operation, setup.

## 4. Binding Decisions (do not re-decide)

- Full regression is mandatory: `T-REG-FEAS-01..12` including 10d (worker restart after a Rome approval; no unrelated `FEASIBLE` reuse) and 03a; `T-IT-CONC-01` (M) and `T-IT-CONC-02` (N) with two actual independently opened SQL connections, not two calls through the app pool.
- Fault/restart evidence uses real processes and real PostgreSQL: controlled worker restart via SIGTERM/SIGKILL as a new OS process, PostgreSQL service restart at a waiting state and mid-operation, commit-before-checkpoint crash, lease expiry/fencing including official-saver `put`/`putWrites` rejection after token rotation. Never a mocked checkpointer; never browser-executed shell commands; the browser only displays operator instructions.
- Reverify3 plan,2 provider,2 adapter attempts and40/USD1 limits. Driver permits3 claims per explicit recovery round; technical retry keeps original operation/revision/scope and monotonic totals. Ordinary input on unfinished failed work is rejected; recovery never resets AI/planning budgets.
- Scenarios A-N are reproducible from persisted seeds and persisted fault overlays; the inspector starts them through protected typed commands, labeled `Simulated failure`. H-N are deterministic action recipes/tests, not new random datasets. Evidence includes the seed/overlay identifiers and observed outcomes.
- Security acceptance evidence: cookie matrix (HttpOnly/Secure/SameSite/Path/expiry per environment; raw token never stored/logged); CSRF/foreign-origin rejection; rate-limit buckets returning 429 with `Retry-After` and surviving web/worker restart; uniform 404 ownership behavior; adversarial chat text cannot emit executable booking/confirmation operations; no success on `202`; production bundle scan proves no server secrets, `DATABASE_URL`, `OPENROUTER_API_KEY`, `pg`, or LangGraph server modules in client chunks; dependencies contain no payment/travel-provider SDK and no payment path exists.
- Retention: the explicit documented cleanup command removes domain rows, events, and checkpoint threads for sessions expired per policy, uses supported checkpointer APIs for the pinned version, and never silently deletes an active owned trip.
- Live AI: the credential-gated smoke (real `intent` plus a planner/reviewer flow, configured role profiles, observed usage/cost) is required for full product acceptance when credentials are configured. Missing credentials leave criterion 28 explicitly `UNVERIFIED`, never passed; fixture tests never claim model quality, and no tokens/costs are fabricated.
- Map hardening: blocked/unavailable tiles must fall back to the static SVG schematic within the 5-second/failure rule with visible attribution; no prefetch/preload of offscreen tiles, no cache-busting, no offline tile packs; `MAP_TILE_URL` is public configuration without credentials; planning continues unaffected; all map facts exist as text.
- Accessibility and UI hardening: keyboard-only completion on desktop (1280x800) and mobile (390x844) viewports; visible unobscured focus (WCAG 2.2 AA 2.4.7/2.4.11; 2.4.13 is an optional AAA aim); target size >= 24 px; `prefers-reduced-motion`; English copy audit; no component generator; Tailwind 4 remains CSS-first with no JS config.
- Reference data: import manifests contain URL, upstream revision/date, SHA-256, license, transform version, counts, and rejected-record report; license/attribution texts are committed; UI data credits render GeoNames/ODbL attribution; runtime never downloads reference data.
- CI order for the final gate: typecheck -> lint -> unit -> real-PostgreSQL integration -> production build -> Playwright. Use isolated disposable test databases/schemas. Do not weaken security or skip environmental prerequisites to manufacture green results; report unavailable checks as blockers/gaps.

## 5. Detailed Ordered Steps

1. Re-read the current tree and evidence from P01-P11; list every test ID whose evidence is missing or stale before running anything.
2. Run the full offline suite in CI order and record raw outputs: typecheck, lint, all unit suites, all integration suites, `npm run build`, full Playwright suite.
3. Execute the mandatory feasibility regression suite including 10d with a real worker restart; capture the restored checkpoint ID and the mismatch rejection record.
4. Execute concurrency M/N with two real connections; capture winner/loser statuses and the absence of mixed state.
5. Execute restart/fault evidence: worker SIGTERM/SIGKILL at an interrupt and mid-operation, PostgreSQL restart at waiting and mid-operation, commit-before-checkpoint replay, lease-expiry/fencing checkpoint-write rejection.
6. Run security hardening checks: cookie matrix, CSRF/origin, rate limits (including restart persistence), ownership 404, prompt-injection jail tests, 202 semantics, inspector redaction, production bundle secret scan, no-payment dependency audit.
7. Run accessibility/mobile/map hardening: keyboard-only journeys at both viewports, English copy audit, tiles-blocked fallback, `prefers-reduced-motion`, focus visibility.
8. Verify reference licenses/manifests/attribution and rerun the import-manifest unit checks; verify the retention cleanup command and its checkpointer-API integration test.
9. Write the operator README and the demo runbook: local start/stop, exact commands, A-N recipes with seed/overlay identifiers and expected outcomes, restart recipes as operator steps, evidence-collection instructions, limitations.
10. Run the credential-gated live smoke when credentials are explicitly configured; otherwise record criterion 28 as `UNVERIFIED`. Produce the final phase report with all evidence paths and remaining gaps.

## 6. Concrete Target Paths

```text
README.md                                                    # operator start/stop/setup/troubleshooting
docs/demo-runbook.md                                         # A-N recipes, seeds/overlays, evidence steps
scripts/{seed-scenario,run-scenario,cleanup-retention,validate-imports}.ts
tests/integration/final/{feasibility-regressions,concurrency-mn,recovery-windows}.test.ts
tests/e2e/{hardening,restart,fallback,a11y}.spec.ts
tests/e2e/harness/restart.ts                                 # real OS-process/DB restart helpers
tests/invariant/{preservation,feasibility,bounds}.test.ts
```

Extend existing suites instead of duplicating modules; reuse the P05 fault harness and P09/P10 overlays.

## 7. Functions and Interfaces to Implement

| Contract | Input -> Output | Required failure behavior |
| --- | --- | --- |
| `runScenario(recipeId, seed, overlay)` | operator/inspector recipe + persisted seed/overlay -> deterministic scenario run | unknown recipe/seed -> typed refusal; browser never executes shell |
| `restartWorker(mode)` / `restartPostgres(mode)` (test harness) | signal/service restart -> new OS process or service | harness-driven only; asserts same thread/reservations recovered |
| `finalFeasibilitySweep()` | regression matrix -> per-ID pass/fail evidence | 10d requires a real restart and restored-checkpoint evidence |
| `bundleSecretScan(distDir)` | production build -> findings | any secret/server module in client chunks fails the gate |
| `cleanupExpiredSessions(now)` | expired sessions policy -> removed rows/checkpoints | never deletes active owned trips; uses supported checkpointer APIs |
| `reportLiveAiStatus(env)` | credential/config presence -> passed or `UNVERIFIED` | never fabricates usage/cost; never claims fixture output is live |

## 8. Outputs / Deliverables

- Full executed evidence set for unit/integration/E2E/invariant/fault suites and the production build.
- Mandatory feasibility, restart, and concurrency (M/N) evidence with raw command output.
- Operator README and demo runbook with reproducible A-N recipes and limitations.
- Security/accessibility/map/import hardening results; retention cleanup verification.
- Final report with honest live-AI status (criterion 28 passed or `UNVERIFIED`) and remaining gaps.

## 9. Measurable Acceptance Criteria

- AC-12-1: `T-REG-FEAS-01..12` including 10d and 03a pass with real restart evidence; no downstream artifact exists after a rejected route (T-REG-FEAS-09/12).
- AC-12-2: M/N pass with two real connections: one reservation/result for M; one deterministic winner and typed conflict for N with no mixed state (T-IT-CONC-01/02).
- AC-12-3: worker/DB restart at a waiting state and mid-operation recover the same thread and reservations; stale saver writes are rejected after fencing rotation (T-IT-FLT-05/06/07, T-E2E-08).
- AC-12-4: security evidence complete: cookie matrix, CSRF/origin, ownership 404, rate limits surviving restart, injection inertness, 202 honesty, bundle scan, no-payment invariant, retention cleanup.
- AC-12-5: keyboard-only journeys pass at desktop and mobile; focus visible/unobscured; map fallback renders when tiles are blocked and planning continues (T-E2E-11/12).
- AC-12-6: `T-INV-01..12` pass; scenario data stable across restarts and independent of AI mode.
- AC-12-7: `npm run build` succeeds; all common commands green on the documented disposable environment.
- AC-12-8: A-N recipes reproduce from persisted seeds/overlays; README/runbook complete; live smoke passed when configured, otherwise criterion 28 explicitly `UNVERIFIED`.

## 10. Commands and Tests

```text
npm run typecheck
npm run lint
npm run test:unit
TEST_DATABASE_URL=... npm run test:integration
npm run build
npm run test:e2e
```

Plus the targeted suites in section 6 and the fault harness for restart/DB/service recipes. Record actual outputs; unavailable prerequisites are reported as blockers, not skipped silently. Never back-date tests.

## 11. Explicit Out of Scope

- New features, architecture, providers, or scope; production-scale load/performance claims; real travel/payment integration; worldwide coverage. This phase adds evidence, hardening, and documentation only.

## 12. Common Mistakes / Traps

- Claiming criterion 28 passed with fixture data or without observed live usage/cost.
- Browser-driven restarts or shell commands; mocked checkpointer passing a restart test.
- Disabling security/rate limits or using one pooled client for M/N.
- Skipping E2E because it is slow, or back-dating test IDs introduced by this phase.
- Fabricating import checksums/licenses or removing required attribution.
- Prefetching/cache-busting tiles or leaving a blank map when tiles fail.
- Deleting database volumes or active trips during cleanup verification; committing secrets or `.env` files.
- Treating green fixtures as proof of model quality or of scenario realism.

## 13. Completion Checklist

- [ ] Read instructions/memory; state active invariants before editing.
- [ ] Full CI-order suite, build, and targeted hardenings executed with raw evidence.
- [ ] Feasibility 10d, M/N, restart/DB, and retention evidence captured.
- [ ] README/runbook complete; A-N recipes reproducible from seeds/overlays.
- [ ] Live-AI status reported honestly (passed or `UNVERIFIED`); remaining gaps listed.
- [ ] Only phase-scope files changed; no commits; final report delivered, then STOP.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase 12 of the AI Travel Planner in this repository (docs/planning/phases/phase-12.md).

Analysis first (no code changes): read AGENTS.md and agent-memory/index.md, then the phase file,
docs/planning/11-testing-strategy.md (sections 7-12, 14), 10-security-reliability.md, 05-synthetic-
data-design.md (sections 2, 12), 08-frontend-ux.md (sections 9, 11, 12, 15), 03-langgraph-design.md
(section 8) and 02-architecture.md (sections 6, 7, 10). Inventory missing/stale evidence from
P01-P11. Report the plan, affected paths, and any contract conflict. Modify nothing in this pass.

Implementation: hardening, evidence, and documentation only. Run the full CI order (typecheck,
lint, unit, real-PostgreSQL integration, build, Playwright) and the targeted suites; execute
T-REG-FEAS-01..12 including 10d with a real worker restart; T-IT-CONC-01/02 with two real
connections; worker SIGTERM/SIGKILL and PostgreSQL restart at waiting and mid-operation via the
test harness (never browser commands); commit-before-checkpoint and fencing/saver-write rejection;
security checks (cookie matrix, CSRF/origin, ownership 404, rate limits surviving restart,
injection inertness, 202 honesty, bundle secret scan, no-payment invariant, retention cleanup);
keyboard/mobile accessibility; tiles-blocked map fallback; import license/manifest verification.
Deliver README.md (operator) and docs/demo-runbook.md with reproducible A-N recipes (persisted
seeds/fault overlays). Run the live OpenRouter smoke only with explicitly configured credentials;
otherwise report criterion 28 explicitly UNVERIFIED, never passed; never fabricate tokens/cost.
Do not add features or architecture; no commits; report unavailable checks as blockers.

Verify: execute phase-12.md section 10 commands and the section 6 suites; capture raw outputs;
check AC-12-1..8 and the section 13 checklist.

Report to the user in Czech: files changed, commands/results, acceptance status, incomplete work,
remaining risks, proposed memory updates only. Then STOP. This is the final phase.
```
