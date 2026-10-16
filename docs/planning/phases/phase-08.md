# Phase 08 - AI Role Profiles, Fixture/Live Adapters, Structured Intent, Clarification, Persistent Chat, and Cost Governance

Status: implementation-phase specification, planning-only; contains no application code.
Authority: `12-implementation-roadmap.md` is the gate authority; contracts are owned by `02`-`11`; this file instructs and never redefines.
Executor: coding agent. Analysis -> implementation -> verification -> STOP before Phase 09.

## 1. Goal

Deliver the provider-independent AI layer and the persistent assistant: strict role profiles for `intent`, `recommendation`, `planner`, `reviewer`; a deterministic `FixtureAdapter` (default, credentials-free) and an `OpenRouterAdapter`; capability/pricing validation before any billable call; durable call reservations and budgets; the `interpret_intent` graph node feeding the existing deterministic command dispatcher; clarification decisions; and the persistent chat UI with conversation persistence. Planner/reviewer roles are configured and contract-tested here but are called by the graph only in Phase 10.

## 2. Prerequisites

- P01-P07 accepted; all common commands green. `AI_MODE=fixture` remains the default.
- P03: contracts (`DomainCommand`, `IntentResult`, `DecisionKind`, `GraphResumeEnvelope`), admission, effect ledger, `withEffect`.
- P05: generic interrupt/decision pipeline, durable events, operation identity/counters.
- P07: service/program UI and booking flows that a command can refresh without side effects.

## 3. Source Inputs (authoritative)

- `06-ai-agent-design.md` sections 1-11: roles, adapter contract, transport, output schemas, prompts, context budget, budgets, retry/error policy, fixture mode/live acceptance.
- `07-conversation-and-intents.md` sections 1-9: command path, interpretation rules, clarification contract, context/persistence, outcome language, re-entrancy.
- `04-domain-model.md` sections 5, 6, 7: offer refs, command union, decisions/resume, category eligibility bound to the proposal target.
- `10-security-reliability.md` sections 5-8: rate limits, LLM input safety, secrets, inspector redaction.
- `11-testing-strategy.md` sections 5, 6.1, 6.5, 11, 14 (P08 gate).

## 4. Binding Decisions (do not re-decide)

Cost bounds include requestPriceUsd per attempt and all conditional/peak tariff overrides plus known additive charges. Refresh prices per new operation; provider.max_price has prompt/completion/request caps covering all matched endpoint variants. Base-only/ambiguous pricing is refused before billing (T-IT-COST-04).

- Four roles only: `intent`, `recommendation`, `planner`, `reviewer`. There is no Response Agent or extra post-execution LLM call; outcome templates plus validated role explanations compose the assistant response from committed results.
- `AI_MODE=fixture` is complete offline. `AI_MODE=openrouter` requires the server key and all four explicit role profiles; never hardcode one model, never silently substitute or fall back to another/free model.
- Do not guess model IDs or prices. Profiles are operator configuration; validate existence, structured-output support, required schema features, settings support, and price bounds against a cached OpenRouter capability/pricing manifest before the first billable call. Unknown capability/pricing = fail closed, no ledger row as if priced.
- Adapter owns at most one retry (2 total calls including a schema repair). Never stack a graph retry on the same call. 401/403, unsupported parameters/schema/model, input overflow, absent pricing, exhausted budget, and user abort are not retried.
- Cost governance: defaults 40 attempted billable calls and USD 1.00 per trip; every retry counts. Reserve worst-case cost before transport under a short SQL lock; role/per-call ceilings apply; store USD as fixed-precision strings in `numeric(18,9)` with integer/BigInt upward rounding, kept strictly separate from travel EUR. Timeout/crash with unknown billing retains the reservation until explicit reconciliation; never release an uncertain charge as zero.
- Telemetry and inspector redaction: only role/model, prompt version label, token counts, latency, cost status (`actual`/`estimated`/`unknown_reserved`), validation status, attempts. Never prompts, raw responses, reasoning/chain-of-thought, provider payloads, cookies, or keys.
- Model-facing intent subset excludes `set_simulation`, confirmations/cancellations, request IDs/revisions, and foreign operation IDs. At most 4 compatible commands; unknown keys and arbitrary operations rejected; conflicting writes or `preserve` conflicts rejected before execution.
- Clarification persists the original typed `requestedCommands` (0..4, not executed) and `preserve` scope separately from its 2..4 options. A deterministic semantic conflict converts a `commands` result into the same clarification form before any partial execution. Relative counts become absolute `set_activity_requirement` values (1..7, `null` clears) computed against current actual tags; the numeric request is never lost in prose.
- Relative cheaper search preserves the selected/confirmed offer's category unless the user explicitly supplies `level`; without a selection use the effective category plus a clarification or shown budget cap. Category eligibility is checked against the proposal's bound target, not blindly against the current global default.
- Context is compact and structured: authoritative current preferences/refs, <= 6 recent messages, deterministic summary of older resolved requests, history <= 4096 tokens, role input <= 6000 tokens. Preferences are never reconstructed from prose; the full transcript is never resent.
- Persistence order: store the user message on admission, an interpretation only after validation, the assistant result only after the operation outcome is persisted. Duplicate `requestId` reuses the original message/operation/result and makes no second billable call.
- OpenRouter transport: `response_format` `json_schema` with `strict: true`, `provider.require_parameters: true`, allowed verified endpoint provider IDs, fallback disabled outside that allowlist, reasoning excluded when supported and discarded regardless. `finish_reason: "length"`, missing/empty content, or truncated JSON are failures, never a valid empty command.

## 5. Detailed Ordered Steps

1. Implement `RoleProfile` schema, `AI_CONFIG_PATH` loader, and startup syntax validation; fixture default with no credential requirement; explicit actionable errors for unsupported settings.
2. Implement the capability/pricing manifest service (cached up to 24 hours, stub-able offline) and `npm run ai:validate-models` for explicit refresh; fixture tests never query the network.
3. Implement `LLMAdapter.generateObject<T>` with `FixtureAdapter` (scripted intents, deterministic rankings, invalid-first-itinerary fixture data) and `OpenRouterAdapter` (server fetch, abort deadline below lease, strict response handling per section 4).
4. Implement durable call governance in `llm_calls`: reserve attempt + worst-case cost, refuse before transport when a trip/role ceiling or pricing would be exceeded, persist call identity/effect scope/versions, record actual usage, and persist the validated object under its effect scope before returning to the graph.
5. Implement `interpret_intent`: build the compact context, call the `intent` role with prompt version `intent-v1`, validate the strict union, apply semantic guards (membership, `preserve`, duplicates, conflicts), and route `commands` to the existing dispatcher or persist a clarification plus `prepare_decision: clarification`.
6. Bind clarification options server-side: opaque option IDs resolve to stored command lists; a click submits only the option ID; free-text follow-up runs as a new admitted operation through the current interrupt's internal `modify` branch (worker-constructed only).
7. Implement conversation persistence and the persistent assistant rail: message roles/sequence, structured interpretation card (detected intent, affected/preserved services, requirement chips, status), clarification options plus free text, `Deterministic fixture mode - no live AI calls` label, and outcome language without premature success claims.
8. Configure/contract-test remaining profiles; recommendation graph calls arrive in Phase09, planner/reviewer orchestration in Phase10.
9. Implement rate buckets for chat-triggering calls and assert fixture mode performs zero OpenRouter egress.

## 6. Concrete Target Paths

```text
packages/ai/src/{index,config,capabilities,adapter,fixture-adapter,openrouter-adapter,telemetry}.ts
packages/ai/src/roles/{intent,recommendation,planner,reviewer}.ts
packages/ai/src/prompts/{intent-v1,recommendation-v1,planner-v1,reviewer-v1}.ts
packages/ai/src/context/compact-context.ts
packages/workflow/src/nodes/interpret-intent.ts
packages/persistence/src/{conversations,llm-calls}.ts
packages/persistence/migrations/0008-ai.sql  # required ALTER/index evolution only; tables created in03
apps/web/src/app/api/trips/[id]/commands/route.ts        # extend chat input admission
apps/web/src/components/assistant/{conversation-rail,message-list,interpretation-card,clarification-options}.tsx
scripts/ai-validate-models.ts
tests/unit/ai/{schemas,profiles,costs}.test.ts
tests/integration/ai/{intent,clarification,cost-ledger,fixture-mode}.test.ts
tests/e2e/phase-08.spec.ts
```

## 7. Functions and Interfaces to Implement

| Contract | Input -> Output | Required failure behavior |
| --- | --- | --- |
| `loadRoleProfiles(configPath, env)` | server config -> validated `RoleProfiles` | missing/invalid profile -> startup error; fixture mode needs none |
| `refreshCapabilityManifest(cache)` / `assertModelCapable(profile)` | cached provider metadata -> typed result | unknown capability/pricing -> fail closed before any billable call |
| `LLMAdapter.generateObject<T>(request: StructuredRequest<T>)` | bounded request -> strict validated `StructuredResponse<T>` | at most 2 total attempts; typed failure on exhaustion; no silent model change |
| `reserveCall(tx, { operationId, role, effectScope, profile })` | call plan -> reservation row or refusal | over-limit/unknown price -> typed refusal, no transport |
| `recordCallResult(tx, callId, usage)` / `reconcileUnknownBilling(tx, callId)` | usage/telemetry -> ledger update | unknown billing kept reserved until reconciliation |
| `interpretIntent(ctx, messageRef)` | message + compact context -> persisted `IntentResult` | invalid/foreign refs rejected; no mutation before validation |
| `validateIntentSemantics(result, authorizedContext)` | raw union -> accepted result or clarification conversion | duplicate/conflicting writes and `preserve` conflicts rejected |
| `buildCompactContext(tripId)` | authoritative domain rows -> bounded role context | over cap -> reduced-scope failure, never silently dropped constraints |

## 8. Outputs / Deliverables

- Working fixture chat end to end (message -> validated intent -> deterministic application or clarification) with zero network calls.
- OpenRouter adapter and role-profile validation gated by capability/pricing checks; no guessed IDs/prices.
- `llm_calls` ledger with reservations, actual/estimated/unknown status, and enforced 40-call/USD 1.00 defaults.
- Persistent assistant rail with interpretation cards, clarification options, and fixture-mode labeling.
- Unit/integration/E2E tests from section 10; run log and checklist report.

## 9. Measurable Acceptance Criteria

- AC-08-1: fixture mode is the default and complete without credentials; zero OpenRouter egress; fixture counters are separate from real tokens/cost (T-IT-AI-01, fixture tests).
- AC-08-2: strict unions reject unknown keys/arbitrary ops; <= 4 commands; conflicts and `preserve` conflicts rejected; one repair attempt max (T-UT-AI-01, T-IT-LIM-03).
- AC-08-3: unknown model capability/pricing rejects the first billable call (fail closed); pricing validation is cached and never bypassed; no model/pricing guess (T-UT-AI-02, T-IT-COST-02).
- AC-08-4: reservations precede every call; retries count; 40 calls/USD 1.00 defaults hold across chat/resumes/retries; USD kept separate from EUR; unknown billing stays reserved (T-IT-COST-01/03).
- AC-08-5: clarification stores typed unexecuted `requestedCommands` plus `preserve`; no partial command executes before an answer; numeric counts persist as absolute `set_activity_requirement` values; relative cheaper preserves the bound category.
- AC-08-6: no Response Agent call; assistant wording never claims unconfirmed success; inspector/telemetry contain no prompts or reasoning (T-IT-AI-01).
- AC-08-7: prompt-injection text and persisted messages cannot become executable booking/confirmation operations.

## 10. Commands and Tests

```text
npm run typecheck
npm run lint
npm run test:unit
TEST_DATABASE_URL=... npm run test:integration
npm run build
npm run test:e2e -- --grep "phase-08"
```

Tests (P08 gate): T-UT-AI-01/02; T-IT-AI-01; T-IT-COST-01..03; T-IT-LIM-03; fixture default asserted; live `intent` smoke only when credentials are explicitly configured (full role smoke after P10; missing credentials are reported as unverified, not passed). Never back-date tests. Add phase-local conversation-persistence and clarification-binding tests.

## 11. Explicit Out of Scope

- Recommendation calls and parallel research: P09; planner/reviewer itinerary calls: P10.
- Inspector UI, full invalidation matrix, after-END re-entry hardening: P11.
- Final criterion-28 verification, runbook, restart/concurrency evidence: P12.

## 12. Common Mistakes / Traps

- Adding a Response Agent or any extra LLM call after execution.
- Guessing model IDs or inventing prices; hardcoding one app-wide model; silently switching provider/model.
- Prompting with the full transcript or raw database dumps instead of the compact structured context.
- Executing any command before clarification resolution, or losing the numeric request in prose.
- Releasing or zeroing an uncertain charge after a timeout/crash.
- Retrying unsupported provider schema/capability/auth errors or stacking retries. Malformed model JSON may use one explicit repair; transient402 follows the canonical AI policy only.
- Exposing prompts, reasoning traces, or raw provider payloads in events/inspector.
- Billing fixture invocations as real tokens.

## 13. Completion Checklist

- [ ] Read instructions/memory; state active invariants before editing.
- [ ] Four roles, fixture/live adapters, capability/pricing gate, and cost ledger implemented.
- [ ] Intent commands, clarification, and conversation persistence wired to the existing dispatcher.
- [ ] Fixture mode default proven; live mode opt-in and honest about missing credentials.
- [ ] Section 10 commands/tests executed with captured output; gaps reported honestly.
- [ ] Only phase-scope files changed; no commits; STOP before Phase 09.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase 08 of the AI Travel Planner in this repository (docs/planning/phases/phase-08.md).

Analysis first (no code changes): read AGENTS.md and agent-memory/index.md, then the phase file,
docs/planning/06-ai-agent-design.md, 07-conversation-and-intents.md, 04-domain-model.md (sections
5-7), 10-security-reliability.md (sections 5-8) and 11-testing-strategy.md (sections 5, 6.1, 6.5,
11, 14). Inspect the current code for the Phase 03 contracts/dispatcher, Phase 05 durable worker,
and Phase 07 service UI. Report the plan, affected paths, and any contract conflict. Modify nothing.

Implementation: four role profiles (intent/recommendation/planner/reviewer) behind the
provider-independent LLMAdapter; deterministic FixtureAdapter default with zero network calls;
OpenRouterAdapter with strict json_schema transport; capability/pricing validation cached and
fail-closed (npm run ai:validate-models, no guessed model IDs or prices); durable llm_calls
reservations with 40 calls and USD 1.00 per-trip defaults, at most 2 total adapter attempts, USD
kept separate from EUR; interpret_intent + clarification (strict <=4 commands, original typed
requestedCommands and preserve stored unexecuted, numeric counts as absolute
set_activity_requirement 1..7/null, relative cheaper preserves the bound category); persistent chat
rail with interpretation cards and fixture labeling; conversation persistence order per phase-08.md
section 4. No Response Agent or extra LLM call. Do not implement research fan-out, itinerary planning, inspector, or later-phase
features; do not change contracts or add architecture; no commits.

Verify: run typecheck, lint, test:unit, test:integration (TEST_DATABASE_URL), build, and the
phase-08 E2E subset; execute the tests in phase-08.md section 10 and capture exact output; check
AC-08-1..7 and the section 13 checklist. Live smoke only if credentials are explicitly configured;
otherwise report the live intent smoke as unverified.

Report to the user in Czech: files changed, commands/results, acceptance status, incomplete work,
remaining risks, proposed memory updates only. Then STOP. Do not start Phase 09.
```
