# MCPA2A-009: Persist safe observations and bridge them to database SSE

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

The inspector must show real A2A/MCP activity without exposing SDK internals,
prompts, credentials or raw payloads, and without inventing a second event
stream.

## Decision

Persist sanitized `protocol_observations` (bounded codes/counters, safe one-line
details) and bridge them to the existing database-backed SSE. The optional
unique link to an execution event makes ingestion idempotent. Protocol chatter
never changes `trip.revision`.

## Consequences

- The inspector renders persisted evidence, not a live static graph.
- Safe fields only; debugging payloads stay in logs/telemetry with redaction.
- SSE replay and deduplication reuse the existing transport.

## Evidence

`tests/integration/coordinator/inspector.test.ts`,
`tests/e2e/{agent-communication,sse-replay}.spec.ts`.
