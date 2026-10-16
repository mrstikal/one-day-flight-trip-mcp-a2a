# Phase 01: Repository and Runtime Foundation

## 1. Goal

Create the smallest runnable, strictly typed workspace for the approved architecture: self-hosted Next.js BFF/web, a separate Node.js worker, shared packages, PostgreSQL, explicit SQL/checkpointer setup, and working verification commands. Finish with an honest scaffold page, not a fake travel demo.

## 2. Prerequisites

- User has authorized implementation of this phase. The current planning deliverable itself does not implement it.
- Node.js 24 LTS, npm, Docker Compose, and browser installation access are available.
- Inspect the repository and current git status; preserve the brief, plan, memory, and all unrelated changes.
- Read root `AGENTS.md`, `agent-memory/index.md`, and relevant active-context/invariants/architecture notes. State active notes/invariants before editing.
- Use the requested coding agent implementation model when available and explicitly selected; do not pretend a model was selected or silently substitute it. This document is a model-independent execution instruction.

## 3. Inputs

- [Overview and exact stack](../00-project-overview.md#3-final-technology-stack)
- [Architecture/layout/configuration](../02-architecture.md)
- [Domain contracts](../04-domain-model.md), for package boundaries only
- [Frontend tokens/disclaimers](../08-frontend-ux.md)
- [Test commands/evidence rules](../11-testing-strategy.md)
- [Runtime ADR](../decisions/ADR-001-runtime.md)

## 4. Binding Decisions

Node 24; TypeScript 5.9.3 strict; Next 16.4.0 App Router; React/DOM 19.3.0; Tailwind 4.3.3 CSS-first; Zod 4.6.5; PostgreSQL 17; `pg` 8; LangGraph 1.4.21/core 1.2.17; official PostgreSQL saver 1.0.6. Install exact compatible patches for other approved tooling and record them in one lockfile. No ORM, Redis, second HTTP backend, Python runtime, Nx/Turborepo, component generator, payment/travel SDK, or MemorySaver.

Use npm-workspace package names `@odft/web`, `@odft/worker`, `@odft/contracts`, `@odft/domain`, `@odft/data`, `@odft/ai`, `@odft/workflow`, and `@odft/persistence`. Shared packages are private ESM packages with explicit exports and emitted declarations. Web and worker consume their built output; do not create inconsistent path-alias-only development behavior that fails in production.

## 5. Detailed Steps

1. Inspect existing paths/instructions and tool versions. Resolve/pin the approved dependencies and verify peer compatibility before scaffolding extensive code. If incompatible, report concrete evidence instead of changing architecture.
2. Add root package/workspace scripts, strict shared TypeScript configuration, project references/build order, a single lockfile, flat ESLint compatible with Next, and Prettier. Preserve existing `.gitignore` lines and append only necessary build/dependency/secret/test-output ignores.
3. Create the web/worker/shared-package directories from the approved layout. Keep shared entry points minimal; do not prebuild future domain abstractions or empty feature trees.
4. Create a Next.js root layout/page with English title, permanent exact demo disclaimer, `Scaffold - travel planning is not implemented yet`, and the initial cream/ink/teal tokens. Use `@import "tailwindcss"` and `@theme` in CSS; install matching PostCSS integration, not a Tailwind JS config.
5. Create typed server configuration validation. Fixture mode is the default; no OpenRouter key is needed. Require valid database URL, public origin, and strong session HMAC key; do not put secrets in `NEXT_PUBLIC_*` or shared browser exports.
6. Add a Node worker entry point with database readiness, a persisted heartbeat every 10 seconds, termination handling, and no public port. It must not yet claim travel operations or fabricate graph output.
7. Add local Compose PostgreSQL 17 with a named persistent volume, health check, and localhost-only published database port. Provide a separate disposable test database configuration. Secrets belong in ignored local configuration; example credentials are placeholders, not production defaults.
8. Add migration infrastructure, including migration ledger, `odft_app` and `odft_checkpoint` schemas, and the small worker-heartbeat table. Apply migrations under an explicit setup/migration role, serialized by a migration lock.
9. Add `checkpointer:setup` using the official `PostgresSaver` in `odft_checkpoint`. Ensure the schema exists first, call `setup()` explicitly, and close its pool. Do not run DDL concurrently from each web/worker startup.
10. Implement readiness that checks SQL migration/checkpointer schema status and a recent worker heartbeat; liveness is local and never calls OpenRouter or map tiles. Domain/session/API endpoints wait for later phases.
11. Establish all root check commands with nonempty honest smoke coverage: unit configuration/import checks, PostgreSQL setup/heartbeat integration, and Playwright scaffold/disclaimer smoke. Add Playwright browser installation instructions.
12. Add an explicit local configuration setup command if needed to generate development-only secrets without printing/committing them or overwriting an existing `.env`. Document startup/shutdown and test database safety in a concise README requested by this implementation phase.
13. Run the acceptance commands, inspect results/diff, stop tracked dev processes, and report limitations. Stop before Phase 02.

## 6. Target Files

```text
package.json, package-lock.json, tsconfig.base.json, eslint.config.mjs
.gitignore (append intended rules only), .env.example, compose.yaml
apps/web/package.json, tsconfig.json, next.config.ts, postcss.config.mjs
apps/web/src/app/layout.tsx, page.tsx, globals.css
apps/web/src/app/api/health/ready/route.ts
apps/worker/package.json, tsconfig.json, src/main.ts
packages/*/package.json, tsconfig.json, src/index.ts
packages/persistence/src/config.ts, pool.ts, migrate.ts, checkpointer-setup.ts
packages/persistence/migrations/0001-foundation.sql
vitest.config.ts, playwright.config.ts, tests/integration/foundation.test.ts
scripts/setup-local-env.ts  # development-only secret generation, never overwrite/print existing secrets
tests/e2e/scaffold.spec.ts, README.md
```

These are future implementation targets. Adjust only mechanical scaffolder filenames required by the pinned Next version, not module ownership/topology. Do not overwrite an existing file without reading it.

## 7. Functions and Contracts

| Contract | Required behavior |
| --- | --- |
| `parseServerConfig(env)` | Strict typed config; fixture default; safe actionable validation errors |
| `createPool(config)` | Bounded pool, shutdown/error handling, no credentials in logs |
| `runMigrations(pool)` | Ordered versioned SQL, ledger, serialization, repeat execution safe |
| `setupCheckpointer(pool/schema)` | Official saver schema setup as a one-shot deployment command |
| `writeWorkerHeartbeat(workerId)` | Upsert actual process heartbeat; readiness does not pretend a worker is alive |
| readiness response | `ready` only after schema/setup and recent heartbeat; no travel-success claim |

Root `dev` uses a small approved process runner such as `concurrently --kill-others` for shared-package watch, Next dev, and worker watch. It forwards termination to children. Use the environment's tracked background-process tool for servers during verification, not shell `&`/nohup.

## 8. Outputs

- Runnable web scaffold and independent worker against PostgreSQL.
- Committed-compatible lockfile, exact dependency baseline, strict package build/import boundaries.
- Explicit repeatable migrations/checkpointer setup and disposable test configuration.
- Verified CSS-first style/disclaimer and smoke tests; no planning/booking feature falsely advertised.
- README startup/shutdown/configuration/check command instructions.

## 9. Acceptance Criteria

- Every approved workspace builds under strict TypeScript and production Node/Next, not just `tsx`.
- Exactly one web and one worker service exist; no public worker HTTP API, extra backend, ORM, or broker.
- Official checkpointer tables exist after explicit setup, and repeat setup/migrations are safe.
- Worker restart changes its heartbeat/process identity; missing worker makes readiness fail.
- No actual API key/credential is committed or sent to the browser; client bundles exclude server graph/database modules.
- Scaffold renders in English at desktop/mobile widths with exact disclaimer and honest feature status.
- Tailwind styles work without `tailwind.config.js` or another JS Tailwind configuration.
- Test commands execute actual smoke assertions; empty/silent success scripts are rejected.

## 10. Checks

```text
npm ci
docker compose up -d postgres
npm run db:migrate
npm run checkpointer:setup
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
npm run test:e2e
```

Run integration/E2E against the test database and fixture environment, not a production/owned-trip database. Record actual commands/outcomes; report missing Docker/browser permissions honestly. A passing scaffold test does not satisfy full `T-E2E-01` or a future LangGraph restart test.

## 11. Out of Scope

Country/city imports, trip forms/ownership APIs, domain booking tables/services, synthetic offers, feasibility engine, production travel graph, AI role calls/prompts, maps, chat, inspector, and multi-phase implementation. Do not create fake versions of these to make screenshots look complete.

## 12. Common Mistakes

- Upgrading to Node 26/TS 7 or changing Next/React/Tailwind versions without verified need.
- Building only the frontend and keeping an untracked graph promise inside a Route Handler.
- Using `npm --workspaces run dev` sequentially so the worker never starts, or failing to terminate children.
- Missing shared-package emit/exports, causing a production-only module resolution failure.
- Per-process checkpointer DDL races; memory checkpointer disguised as durable.
- Overwriting `.env`/`.gitignore`/user files, deleting a database volume, or committing secrets.
- Claiming future integration/E2E tests passed when only a smoke test exists.

## 13. Completion Checklist

- [ ] Read instructions/memory, inspect status, state active invariants.
- [ ] Scaffold only the approved modules/processes and exact pinned baseline.
- [ ] Configure safe local/test environments and explicit setup.
- [ ] Run/review each check; record unavailable checks as blockers/gaps.
- [ ] Review intended diff and preserve unrelated changes.
- [ ] Report files, validation evidence, limitations, and reusable memory-update proposals only.
- [ ] Stop; do not implement Phase 02 or commit/push without explicit authorization.

## 14. Executor Prompt

```text
Implement ONLY Phase 01 of AI Travel Planner in this repository.

Read AGENTS.md and agent-memory/index.md first, then relevant active-context,
invariants and architecture notes. Inspect the current repository and git status;
preserve all existing/unrelated changes. Documentation/code must be English;
report to the user in Czech. State active memory notes/invariants before editing.

Read docs/planning/00-project-overview.md, 02-architecture.md,
08-frontend-ux.md, 11-testing-strategy.md, decisions/ADR-001-runtime.md,
and phases/phase-01.md. The phase specification is binding.

Create npm workspaces for Next.js web/BFF, a separate Node.js worker, and the
six approved shared package boundaries. Use Node 24 LTS, TypeScript 5.9.3,
Next 16.4.0, React/DOM 19.3.0, Tailwind 4.3.3 CSS-first, Zod 4.6.5,
PostgreSQL 17/pg8, LangGraph 1.4.21/core1.2.17 and the official PostgreSQL
checkpointer1.0.6. Pin compatible tooling and keep one lockfile. No Redis,
ORM, extra HTTP backend, prebuilt agent, Python runtime or Tailwind JS config.

Implement explicit schema migrations/checkpointer setup, bounded pools,
worker heartbeat/shutdown/readiness, fixture-default server configuration,
safe local/test Compose setup, an English honest scaffold page with the exact
demo disclaimer, and real smoke checks. No travel-domain features belong here.
Secrets remain server-side; do not overwrite existing .env files or print keys.
Preserve existing ignore rules. Never remove volumes or revert user changes.

Establish and execute npm ci, db:migrate, checkpointer:setup, typecheck, lint,
test:unit, test:integration, build, and test:e2e against the proper disposable
test environment. Use tracked dev processes and stop them after verification.
If a prerequisite/permission is unavailable, report actual evidence, not success.

Analyze, implement, validate, inspect the diff, and report files/check results/
limitations in Czech. Propose memory updates only; do not edit memory unless
asked. Do not commit or push. STOP after Phase 01; do not begin Phase 02.
```
