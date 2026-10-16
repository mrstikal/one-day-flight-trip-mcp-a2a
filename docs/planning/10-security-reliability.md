# Security and Reliability Specification

This document is the authoritative home for session/security controls, ownership and CSRF rules, rate limiting, LLM input hardening, inspector redaction, and the operational error-recovery model. Architecture (admission transaction, leases, effect ledger, SSE) is owned by [02 Architecture](02-architecture.md); graph crash/stale-checkpoint recovery by [03 LangGraph](03-langgraph-design.md); decision authorization contracts by [04 Domain Model](04-domain-model.md). This document links to those contracts instead of restating them.

## 1. Trust Model and Data Classes

| Class                   | Examples                                          | Trust                                                              |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Server secrets          | database URL, session HMAC key, OpenRouter key    | Never client-visible; environment only                             |
| Public configuration    | uncredentialed tile URL, provenance/display flags | Validated safe projection; tile URLs necessarily reach the browser |
| Server-validated inputs | command schemas, decision responses, revision     | Untrusted until Zod + domain checks pass                           |
| User-provided text      | chat message, first name                          | Untrusted; rendered as text, never HTML/executable                 |
| LLM output              | intent, ranking, schedule/review proposals        | Untrusted; schema-validated proposal only, never authority         |
| Synthetic domain data   | offers, prices, schedules, references             | Application-generated, clearly labeled demo                        |
| External tiles          | OSM raster tiles                                  | Optional, cross-origin, policy-bound; failure degrades to fallback |

There is no user registration or login. Anonymous sessions still enforce ownership, and every trip-scoped read/write is authorized against the owning session.

### Principal threats and controls

| Threat                              | Control                                                                                                  | Evidence                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Session token theft (XSS, logs)     | HttpOnly cookie, no token in JS/logs/URLs, CSP, hashed storage                                           | Cookie-matrix and bundle/log redaction tests            |
| CSRF from another origin            | Exact-origin check plus per-session CSRF header                                                          | Missing/foreign origin and missing-token tests          |
| IDOR / trip probing                 | Per-trip session ownership; uniform 404                                                                  | Foreign-trip access tests                               |
| Replay / duplicate booking          | Request IDs, effect keys, one-active-reservation index                                                   | Duplicate-confirmation and crash-replay tests           |
| Prompt injection or forged approval | Typed commands only; booking/confirm actions are decisions, never model output                           | Adversarial chat tests; no model-emittable confirmation |
| Cost abuse / call storms            | PostgreSQL rate limits plus per-trip LLM call/cost caps                                                  | 429 matrix and LLM cap tests                            |
| Secret leakage                      | Server-only env, least-privilege DB role, redaction, bundle scan                                         | Production-build secret scan                            |
| Tile-policy abuse                   | Attribution, referer, caching, no prefetch/offline packs ([08 Frontend UX](08-frontend-ux.md) section 9) | Map policy checks                                       |

## 2. Sessions and Cookies

- Session token: 256-bit CSPRNG value (`crypto.randomBytes(32)`), base64url-encoded and opaque. It is generated server-side only.
- Stored form: the database never stores the raw token. `anonymous_sessions` stores an HMAC-SHA-256 hash (keyed with `SESSION_HMAC_KEY`, itself a fresh >= 256-bit server secret) and a separate hashed CSRF token ([04 Domain Model](04-domain-model.md) section 9).
- Cookie flags (no `Domain` attribute is set for the single-host deployment):

| Attribute  | Production            | Local development                                                      |
| ---------- | --------------------- | ---------------------------------------------------------------------- |
| `HttpOnly` | true                  | true                                                                   |
| `Secure`   | true (HTTPS required) | false only when `PUBLIC_BASE_URL` is an explicit localhost HTTP origin |
| `SameSite` | `Lax`                 | `Lax`                                                                  |
| `Path`     | `/`                   | `/`                                                                    |
| `Max-Age`  | 30-day sliding        | same                                                                   |

- Lifetime: 30-day sliding expiry on session activity; expiry invalidates authorization but does not delete trip data before the retention cleanup in section 11.
- Ordinary renewal preserves the session ID and cookie secret; it only extends expiry. Do not rotate the secret on each load/renewal and race concurrent tabs out of their owned trips.
- Derive a stable per-session CSRF value with domain-separated HMAC of session ID/creation nonce; retain its validation hash. The server can return it again after reload/restart without storing a raw random CSRF token or rotating other tabs out.
- Token material never appears in localStorage, URL parameters, logs, analytics, or error payloads. Comparison of stored hashes is constant-time.
- SSE connections are read-only, still require the session cookie, and are authorized before replay ([02 Architecture](02-architecture.md) section 8).

Session lifecycle: create on first visit; renew on `POST /api/session` or accepted writes, not GET/SSE. Concurrent renewals extend the same session without replacing its secret. Expired sessions receive `401`; a new anonymous session has no authority over prior trips. Recheck SSE authorization/expiry at least every five minutes and terminate an expired connection. Explicit security revocation invalidates the session; ordinary browsing does not rotate it.

Endpoint check matrix (`E` = enabled requirement):

| Endpoint                                              | Session | Origin + CSRF | Rate bucket    | Additional validation                                                                       |
| ----------------------------------------------------- | ------- | ------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `POST /api/session`                                   | create  | origin        | session-create | HMAC-hashed storage                                                                         |
| `POST /api/trips`                                     | E       | E             | trip-create    | Zod welcome/destination contract; reference membership                                      |
| `GET /api/trips/:id`                                  | E       | read          | read           | Ownership; safe projection only                                                             |
| `POST /api/trips/:id/commands`                        | E       | E             | commands       | Revision, strict command union, preserve conflicts                                          |
| `POST /api/trips/:id/resume`                          | E       | E             | resume         | Decision UUID, kind, interrupt binding, fingerprint, revision                               |
| `POST /api/trips/:id/operations/:op/retry`            | E       | E             | resume         | Latest failed unfinished operation, stored-input identity, dedupe; no new business revision |
| `GET /api/trips/:id/events` (SSE)                     | E       | read          | SSE            | Ownership before replay; dedupe by event ID                                                 |
| `POST /api/trips/:id/commands` (inspector simulation) | E       | E             | commands       | `DEMO_CONTROLS_ENABLED` plus owned trip                                                     |

## 3. Ownership and Authorization

- Every `/api/trips/:id...` handler loads the trip and requires `trip.sessionId === currentSession.id`; worker routes are internal only and expose no public HTTP API.
- Requests for trips that do not exist or belong to another session return `404` with a uniform body, so trip IDs are not an existence oracle.
- Authorization is per trip, not per resource ID. An offer ID, proposal ID, decision ID, or demo reference is never sufficient authority on its own; membership and ownership are re-checked server-side.
- The pending decision and its interrupt binding are scoped to the owning session and thread; validation of a resume response follows [04 Domain Model](04-domain-model.md) section 7 exactly, including the decision UUID, revision, source fingerprint, and actual current interrupt. An additional browser decision bearer token is deliberately not used.
- A model or checkpoint cannot bypass ownership: worker nodes execute under the operation's admitted session context, and `getState`/checkpoint data is treated as data, not authorization.
- Worker-internal repositories and checkpointer access are never exposed through browser routes; LangGraph APIs are not reachable from any Route Handler.

## 4. CSRF and Origin Checking

- All state-changing endpoints require `Origin` exactly matching `PUBLIC_BASE_URL`; reject absent/foreign Origin. Initial session creation/renewal requires origin and current cookie if present; all other writes additionally require the CSRF header. No undocumented Referer bypass is allowed.
- A per-session CSRF token is required in the `X-CSRF-Token` header and compared constant-time against the stored hash. The token is fetched with the session projection and is single-session scoped.
- CORS: no cross-origin API access is allowed; the app is same-origin only. Route Handler responses set `Vary: Cookie` where responses depend on session.
- GET/SSE endpoints do not mutate state; they still require ownership and same-origin behavior.
- Security headers: CSP default self, only configured tile image origin, `frame-ancestors 'none'`, nosniff, and strict-origin-when-cross-origin referrer policy. Next.js bootstrap scripts use a request nonce/hash strategy rather than blanket unsafe-inline; allow required non-executable map positioning styles separately. Owned APIs/projections use private/no-store caching, and never shared static trip caching.

## 5. Rate Limiting (PostgreSQL-backed)

Rate-limit buckets live in `rate_limit_buckets`, keyed by an HMAC of session ID (or IP for pre-session endpoints) plus endpoint class, with atomic increment/expiry. No Redis is introduced.

| Bucket                                       | Initial limit                                                                                   | Failure mode                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------- |
| Session create/renew                         | 10/hour per IP hash                                                                             | Fail closed (429)                  |
| Reference search (countries/cities/airports) | 60/minute per session                                                                           | Fail open with static client cache |
| Trip commands (UI or chat)                   | 30/minute per trip                                                                              | Fail closed                        |
| Decision resume                              | 20/minute per trip                                                                              | Fail closed                        |
| Chat messages triggering LLM calls           | 10/minute per trip plus the per-trip LLM caps ([02 Architecture](02-architecture.md) section 9) | Fail closed                        |
| SSE connect/reconnect                        | 30/minute per trip                                                                              | Fail closed                        |
| Trip creation                                | 5/hour per IP hash                                                                              | Fail closed                        |

Exceeded limits return `429` with `Retry-After`; counters never replace domain checks. Rejections use redacted server log events with hashed identifiers, not writes into a foreign trip's execution ledger. Reference cache fallback serves only public offline records. Isolate test buckets/databases per suite rather than claiming tests passed with security disabled.

## 6. Input, Command, and LLM Safety

- Every request body is Zod-validated with strict objects; unknown keys are rejected at executable boundaries. Body size is capped (JSON command/body <= 64 KiB; chat message 1-2000 chars, no raw HTML).
- Commands are the strict discriminated union in [04 Domain Model](04-domain-model.md) section 6. The model-facing subset is smaller: `set_simulation`, direct confirmation/cancellation, and any execution of booking writes are not model-emittable. Bounded fields stay bounded (e.g., `set_activity_requirement` accepts an integer 1..7 or `null`); relative counts are converted to absolute typed values server-side before persistence.
- Membership checks are mandatory: offer IDs must belong to the current snapshot and option IDs to the pending decision. Model-proposed clarification options are strictly validated and bound server-side before becoming authoritative choices.
- AI output is a proposal: intent commands, rankings, itinerary candidates, or reviews. Deterministic code authorizes, prices, validates, schedules, and books. A model phrase asserting "confirmed", "booked", or "paid" is inert.
- Prompt injection: user and reference text are delimited data, never instructions; the adapter exposes no tools with side effects; only structured outputs validated by Zod are accepted. Suspicious content is recorded as a safe event and answered with a refusal/clarification, without revealing system prompts.
- Conversation context sent to the model is a compact structured summary, not raw database dumps, tokens, or other users' data ([07 Conversation and intents](07-conversation-and-intents.md)).

## 7. Secrets and Configuration

- All credentials are server-side environment variables validated at startup ([02 Architecture](02-architecture.md) section 9). Nothing sensitive is prefixed `NEXT_PUBLIC_`; client bundles are checked in CI/tests for `pg`, LangGraph server modules, and secret names.
- Startup validates required secrets/config syntax; OpenRouter mode additionally requires credentials and role profiles. Endpoint/schema/capability/pricing validation occurs before the first billable call, as specified in [AI design](06-ai-agent-design.md), without blocking unrelated deterministic wizard work.
- Logs redact cookies, CSRF tokens, `DATABASE_URL`, API keys, and full headers; errors returned to the browser use the safe envelope `{ code, message, retryable, currentRevision?, operationId? }`, never raw provider or database exceptions.
- Production uses HTTPS, secure cookies, an explicit `PUBLIC_BASE_URL`, and a least-privilege database role. Local `.env` files are ignored; `.env.example` holds placeholders only.
- Demo controls default off outside explicit local/demo deployment and require the flag plus an owned trip. `MAP_TILE_URL` is optional public configuration, never a place for a secret; reject credentialed URLs and invalid/non-HTTPS production schemes.
- Prompt versions and model IDs are server configuration; the inspector may display role/model labels and prompt _version identifiers_, but never prompt text.
- Client bundle exposure check: the production build is scanned to prove that no server secret, `DATABASE_URL`, `OPENROUTER_API_KEY`, `pg`, or LangGraph server module is present in client chunks; only public display flags reach the browser.
- Rendered assistant output is plain text with no HTML, no script, and no client-side markdown execution; any link is server-generated and allowlisted.

## 8. Inspector Redaction

Allowed in the inspector: node names/statuses, attempts, checkpoint IDs, interrupt IDs, operation IDs, durations, scenario mode, injected-fault labels, and LLM telemetry rows (role, model, prompt version label, tokens, estimated cost, structured-validation status, retry count).

Forbidden, without exception: prompt text, raw model output beyond validated structured fields, chain-of-thought or reasoning traces, provider request/response payloads, SQL text, stack traces, cookies, secrets, and raw headers. Events are projected before persistence; the inspector cannot reveal what was never stored ([02 Architecture](02-architecture.md) section 8). Tests assert these fields never appear in event payloads or the DOM.

## 9. Error Taxonomy and Client Semantics

| Class                        | HTTP                        | Behavior                                                                               |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| Schema/validation            | 400                         | No state change; field-level message                                                   |
| CSRF/origin failure          | 403                         | No state change                                                                        |
| Body too large               | 413                         | No state change                                                                        |
| Stale revision               | 409 `STALE_REVISION`        | UI refreshes; command is not replayed                                                  |
| Operation in progress        | 409 `OPERATION_IN_PROGRESS` | UI waits for current operation                                                         |
| Unfinished failed checkpoint | 409 `RECOVERY_REQUIRED`     | Retry the same operation through the technical control; preserve unsent ordinary input |
| Stale/expired decision       | 409 `STALE_DECISION`        | Refresh projection; no resume executed                                                 |
| Rate limit                   | 429                         | `Retry-After`, safe message                                                            |
| Ownership                    | 404                         | Uniform body                                                                           |
| Simulated provider fault     | 200 projection/event        | Labeled `Simulated failure`; not an incident                                           |
| Dependency unavailable       | 502/503                     | Retryable envelope; operation remains durable                                          |
| Internal                     | 500                         | Safe message; operation marked failed with recovery path                               |

Trip operations return `202` with operation ID/revision; session creation/renewal returns `200`, and identical request replay returns its stored outcome/status. No `202` is rendered as success. A booking transaction is atomic, but a fully committed booking may precede checkpoint failure: display the saved booking and recovery-needed workflow honestly, never claim that the failed workflow had no domain effect.

## 10. Restart, Fault, and Stale-Checkpoint Handling

- Single trip writer: only the worker invokes graph threads, under an advisory lock and lease/fencing token; the web tier never calls the same thread concurrently ([02 Architecture](02-architecture.md) section 6).
- Invocation selection follows the state/operation table in [03 LangGraph](03-langgraph-design.md) section 8: plain input for new runs, `Command(resume)` only for an exact current interrupt, `null` only for unfinished recovery work, never to start a modification.
- Stale approvals: route/schedule/itinerary fingerprints are re-checked against current domain inputs before generation, booking, and approval; a checkpoint cannot supply feasibility proof. The PRG -> Rome -> city-change regression is mandatory ([05 Synthetic data](05-synthetic-data-design.md) section 5).
- Checkpoint errors are never converted to fabricated success; checkpoint versions incompatible with the compiled graph are refused with `GRAPH_VERSION_UNSUPPORTED` and an explicit migration/reset procedure ([04 Domain Model](04-domain-model.md) section 10).
- Crash windows: commit-before-checkpoint replay reads the effect ledger; checkpoint-written-but-unreconciled recovery repairs projection/events without duplicating effects ([02 Architecture](02-architecture.md) section 7).
- Graceful shutdown stops claims, aborts or finishes within 30 seconds, and leaves unfinished operations recoverable by lease expiry.
- LLM/network calls carry deadlines below the lease and an abort signal; simulated provider failures are tagged domain results that preserve sibling research results.

### Degraded modes

| Degraded dependency                         | Behavior                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| OpenRouter unavailable (openrouter mode)    | Affected operation fails with a safe retryable error after bounded attempts; deterministic wizard steps and fixture mode are unaffected |
| Map tiles unavailable or blocked            | Offline schematic map per [08 Frontend UX](08-frontend-ux.md) section 9; planning is unaffected                                         |
| SSE unavailable                             | Polling fallback via `GET /api/trips/:id`; operations are unaffected                                                                    |
| PostgreSQL unavailable                      | Writes fail with a safe retryable error and no partial booking; the worker stops claiming while writes fail                             |
| Worker stopped or crashed                   | Commands still queue (`202`) and display as `queued`; after restart, lease expiry recovers the same operations                          |
| Checkpointer schema missing or incompatible | Readiness check fails; the worker does not claim; run the explicit setup/migration procedure                                            |

## 11. Privacy, Retention, and Data Hygiene

- Collected data is minimal: first name, anonymous session, trip inputs, synthetic trip data, conversation messages, and telemetry. No email, password, phone, or payment data is collected.
- Sessions expire after 30 days of inactivity; demo data retention is 30 days after session expiry, removed by an explicit documented cleanup command covering domain rows, events, and checkpoint threads. Active owned trips are never silently deleted.
- Cleanup uses supported checkpointer APIs for the pinned version and is covered by an integration test.
- Telemetry (`llm_calls`, `execution_events`) is retained with the trip and removed by the same cleanup; it contains no prompt text, reasoning, or credentials.
- Backups of the local demo database are out of scope; operators must not place real personal data into a demo instance.

## 12. Security and Reliability Acceptance Evidence

Specified for [11 Testing](11-testing-strategy.md) and scheduled by [12 Roadmap](12-implementation-roadmap.md); this plan does not claim these tests have run.

- Cookie matrix: HttpOnly/Secure/SameSite/Path/expiry asserted per environment; raw token never stored or logged.
- CSRF/origin: missing or foreign origin rejected; missing/mismatched CSRF header rejected; resume cannot execute with a foreign session, wrong revision, wrong decision UUID, or stale interrupt.
- Ownership: foreign trip access returns 404 and mutates nothing.
- Rate limits: each bucket returns 429 with `Retry-After`; limits survive worker/web restart.
- Injection: adversarial chat text cannot emit executable booking/confirmation commands; confirmation cannot originate from model output.
- 202 semantics: a queued response never renders success before the operation outcome event.
- Recovery: worker restart at a pending decision resumes the exact decision; duplicate confirmation after a crash creates one reservation; stale route approval cannot be reused after a city change.
- Redaction: inspector DOM/events contain no prompts, reasoning, provider payloads, SQL, secrets, or cookies; client bundles contain no server secrets or `pg`/LangGraph server modules.
- No-payment invariant: no payment provider package, endpoint, or record exists; the booking service cannot construct a payment intent.

## Voice security and reliability addendum (2026-10-15)

- **Guarded speech routes.** All three voice routes run the standard guard chain (Origin -> session -> CSRF -> rate bucket: `voice:stt` 10/min, `voice:tts` 20/min) before any transport; trips and messages are looked up server-side (owned trip, same-trip settled operation) with a uniform 404 that never leaks existence. Rejected input classes perform zero provider calls.
- **Byte and duration caps.** The transcription body is read with a hard 2 MiB stream cap (cancel on overflow, `Content-Length` never trusted); the JSON cap stays 64 KiB. Only canonical 16 kHz mono PCM WAV is accepted (strict header/length/sample validation) and the profile's recording-duration limit is enforced before any billable transport; TTS responses are capped at 8 MiB and content-type checked.
- **Ephemeral audio policy.** No audio bytes, transcripts, or TTS text are persisted or logged; the ledger stores only safe accounting fields. The browser discards recorder chunks after transcription and keeps at most one decoded reply buffer for the _Play reply_ gesture.
- **Private responses.** Every voice response carries `Cache-Control: no-store` and `Vary: Cookie`; raw audio responses forward no upstream headers. Keys are server-side only, never in URLs, bodies, or the browser.
- **Unknown-billing behavior.** Timeout/transport/abort and ambiguous upstream failures retain the reservation (`unknown_reserved`); only explicit operator reconciliation with verified billing evidence settles it, and failures that provably never reached the provider close as `failed` with the reservation retained.
- **Key/allowlist runbook (operator).** Create a separate inference key; create a guardrail with provider allowlist exactly `groq` and model allowlist exactly `openai/whisper-large-v3-turbo`; **assign** it to the key (a guardrail enforces nothing until assigned); set only that key as `OPENROUTER_STT_API_KEY`; verify the effective policy with a disallowed-model attempt before enabling live voice. Failure behavior is a voice-only 503 - never a silent fallback or key substitution. Effective-policy verification is currently pending guardrail assignment.
- **Local VAD assets and redaction tests.** The Silero model, worklet, and ONNX runtime files are same-origin only (`/voice-vad/`, licenses recorded in the generated MANIFEST); no raw audio frames leave the device; CSP is unchanged because the verified integration needs no external CDN. Redaction is pinned by T-UT-VOICE-12 (event whitelist), the inspector integration test (no content/fingerprints/generation ids), and the client-bundle token scan (`OPENROUTER_STT_API_KEY`, `VOICE_CONFIG_PATH`, `VOICE_ENABLED`, `voice-profiles.json`).
