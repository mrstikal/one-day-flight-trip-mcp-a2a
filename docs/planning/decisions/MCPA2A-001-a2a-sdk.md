# MCPA2A-001: A2A 1.0 via the official JavaScript SDK

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

The migration needs real task lifecycle, streaming, input-required and
cancellation semantics. A homemade message layer would be a fake protocol and
would not prove interoperability.

## Decision

Use A2A 1.0 with the pinned `@a2a-js/sdk@1.3.0` JSON-RPC binding and the SDK's
SSE transport. The served binding is the modern 1.0 shape only; legacy 0.3
compatibility stays disabled.

## Consequences

- Agents use the official task store and admission/replay semantics.
- Legacy A2A clients are rejected instead of silently adapted.
- SDK upgrades require re-running the interoperability and lifecycle suites.

## Evidence

`tests/integration/a2a/*`, `tests/integration/protocols/sdk-interoperability.test.ts`,
`docs/protocols/contracts.md`.
